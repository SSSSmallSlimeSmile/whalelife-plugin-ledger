/*! 会话累计用量：宿主 sessions.context() 里的 consumption 是每个会话的全量计数。
 *
 * 为什么需要它：账本（usage_today）读的是会话记录里的 request_usage，而那份记录
 * 每轮只在收尾写一次；一轮里跑了十几次模型，只有最后一次落进记忆。
 * sessions.context() 给的是 memory engine 自己维护的累计用量，不丢中间那些轮。
 *
 * 只读：只调 ctx.sessions.list() / ctx.sessions.context()，不改任何东西。
 */
type UsageTotals = { input_tokens: number; output_tokens: number; requests: number; unknown_requests: number };

export type SessionUsage = {
  id: string;
  name: string;
  updatedAt?: string;
  chat: UsageTotals;
  memory: UsageTotals;
};

export type UsageSummary = {
  ok: boolean;
  error?: string;
  persona?: string;
  sessions: SessionUsage[];
  chat: UsageTotals;
  memory: UsageTotals;
};

type UsageScope = "all" | { id?: string; personaId?: string };

const zero = (): UsageTotals => ({ input_tokens: 0, output_tokens: 0, requests: 0, unknown_requests: 0 });

function add(into: UsageTotals, from?: UsageTotals) {
  if (!from) return into;
  into.input_tokens += Number(from.input_tokens) || 0;
  into.output_tokens += Number(from.output_tokens) || 0;
  into.requests += Number(from.requests) || 0;
  into.unknown_requests += Number(from.unknown_requests) || 0;
  return into;
}

/** 宿主的人格键：ctx.personas.list() 给的是 {id,name,model}，id 就是 config.personas 的键。 */
async function personaKeys(ctx: any): Promise<string[]> {
  try {
    const list = await (ctx.personas?.list?.() ?? []);
    return (Array.isArray(list) ? list : []).map((p: any) => String(p?.id ?? "")).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 逐个会话读累计用量。
 * context(id, persona) 要求 persona 存在，所以先探出能用的那个，之后复用。
 * 全局范围可以按 updatedAt 筛选。单会话接口不返回更新时间，沿用缺失时纳入统计的规则。
 */
export async function sessionUsage(ctx: any, scope: UsageScope, days = 0): Promise<UsageSummary> {
  const out: UsageSummary = { ok: false, sessions: [], chat: zero(), memory: zero() };
  if (scope !== "all" && !scope.id) {
    return { ...out, error: "没有可统计的范围：当前调用既没有 full 权限，也拿不到会话 id。" };
  }
  const api = ctx.sessions;
  if (typeof api?.context !== "function") {
    return { ...out, error: "宿主没有 sessions.context（版本太旧？）" };
  }

  let list: any[];
  if (scope === "all") {
    try {
      list = await api.list();
      if (!Array.isArray(list)) return { ...out, error: "sessions.list() 没返回数组" };
    } catch (error: any) {
      return { ...out, error: `列会话失败：${String(error?.message ?? error)}` };
    }
  } else {
    list = [{ id: scope.id }];
  }

  const persona = scope === "all" ? undefined : scope.personaId;
  const keys = persona ? [persona] : await personaKeys(ctx);
  if (!keys.length) return { ...out, error: "ctx.personas.list() 没给出任何人格" };

  const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;
  let chosen = "";
  const failures: string[] = [];

  for (const item of list) {
    const id = String(item?.id ?? "");
    if (!id) continue;
    const updatedAt = item?.updatedAt ? String(item.updatedAt) : "";
    if (cutoff && updatedAt) {
      const at = Date.parse(updatedAt);
      if (Number.isFinite(at) && at < cutoff) continue;
    }

    // 人格只用来过 context() 的校验；记下第一个能用的就够，后面不再逐个试。
    const candidates = chosen ? [chosen] : keys;
    let got: any = null;
    for (const persona of candidates) {
      try {
        got = await api.context(id, persona);
        chosen = persona;
        break;
      } catch (error: any) {
        failures.push(`${id}@${persona}: ${String(error?.message ?? error)}`);
      }
    }
    if (!got) continue;

    const chat = got.consumption?.chat ?? zero();
    const memory = got.consumption?.memory ?? zero();
    if (!got.consumption) continue;
    out.sessions.push({ id, name: String(item?.name ?? got.name ?? id), updatedAt, chat, memory });
    add(out.chat, chat);
    add(out.memory, memory);
  }

  out.ok = true;
  out.persona = chosen;
  if (!out.sessions.length && failures.length) out.error = failures[0];
  out.sessions.sort((a, b) => b.chat.input_tokens - a.chat.input_tokens);
  return out;
}

const n = (value: number) => Math.round(value).toLocaleString("en-US");

export function usageText(summary: UsageSummary): string {
  if (!summary.ok) return `读会话累计用量失败：${summary.error ?? "未知原因"}`;
  const lines: string[] = [];
  lines.push(
    `会话累计（宿主 sessions.context）：${summary.sessions.length} 个会话 · 请求 ${n(summary.chat.requests)} 次 · ` +
      `输入 ${n(summary.chat.input_tokens)} · 输出 ${n(summary.chat.output_tokens)}`,
  );
  lines.push("按会话：");
  for (const row of summary.sessions.slice(0, 12)) {
    lines.push(
      `  ${row.name}（${row.id}）  请求 ${n(row.chat.requests)}  入 ${n(row.chat.input_tokens)}  出 ${n(row.chat.output_tokens)}`,
    );
  }
  return lines.join("\n");
}

/** 注册一个只读诊断路由和一个工具。路由不传 entry，所以不会出现在页面列表里。 */
export function registerConsumption(ctx: any, disposers: Array<() => void>) {
  const web = ctx.web;
  if (web && typeof web.page === "function") {
    const route = web.page("/plugins/ledger/consumption", async (req: any, res: any) => {
      const url = new URL(String(req.url ?? "/"), "http://local");
      const days = Math.min(60, Math.max(0, Number(url.searchParams.get("days")) || 0));
      let summary: UsageSummary;
      try {
        summary = await sessionUsage(ctx, "all", days);
      } catch (error: any) {
        summary = { ok: false, error: String(error?.message ?? error), sessions: [], chat: zero(), memory: zero() };
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(summary));
    });
    if (typeof route === "function") disposers.push(route);
  }

  disposers.push(
    ctx.tools.register({
      name: "usage_sessions",
      description:
        "读宿主的累计用量（请求数、输入/输出 token）。普通调用只读本会话，full 权限可汇总全部会话。" +
        "比账本准：账本每轮只记最后一笔请求，这里是会话累计。只读。",
      schema: {
        type: "object",
        properties: {
          days: { type: "integer", description: "全局查询只算最近几天更新过的会话；0 表示全部，默认 0", minimum: 0, maximum: 60 },
        },
        additionalProperties: false,
      },
      danger: "safe",
      async run(args: any, session: any) {
        const days = Math.min(60, Math.max(0, Number(args?.days) || 0));
        const scope = session?.permission === "full" ? "all" : { id: session?.id, personaId: session?.personaId };
        const summary = await sessionUsage(ctx, scope, days);
        const note = scope !== "all" && scope.id ? "\n范围：仅本会话。" : "";
        return { text: usageText(summary) + note, summary };
      },
    }),
  );
}

export { zero as __zero, add as __add };
