/*! WhaleLife「账本」插件：把会话里记下的 request_usage 按价目表重算成参考金额。
 *
 * 为什么做成插件：它只需要读 memory/sessions 下的 jsonl，再把结果画出来，
 * 不需要在回合开始前插一手，所以不必动主干。
 *
 * 三条不变量：
 * 1. 只读。不写会话、不拦请求、不改任何用量记录。
 * 2. 金额是参考价，不是账单。算不出来就记「未定价」，绝不猜一个数。
 * 3. 缓存缺失、峰谷时段这类「只能给区间」的行，页面显示区间，不取上界。
 *
 * 页面直接引用宿主的 /ui/styles.css，所以它和管理页是同一套样式，
 * 不是照着画一份，宿主改配色这里跟着变。
 */
import type { Context } from "whalelife";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectDays, collectHours } from "./usage.ts";
import { sessionUsage, usageText } from "./consumption.ts";
import { registerUsageTools } from "./usage-log.ts";
import { VERIFIED } from "./prices.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** plugins/ledger → 仓库根。 */
const ROOT = resolve(HERE, "../..");

const DEFAULTS = {
  enabled: true,
  /** 明细表默认看几天。 */
  days: 7,
  /** 额外统计 memory/usage-judge.jsonl（按难度挑模型的扩展才有）。 */
  include_judge_usage: false,
};

type Config = typeof DEFAULTS;

async function loadGlobal(): Promise<any> {
  for (const name of ["config/config.json", "config.json"]) {
    try {
      return JSON.parse((await readFile(join(ROOT, name), "utf8")).replace(/^\uFEFF/, ""));
    } catch {
      /* 试下一个 */
    }
  }
  return {};
}

const money = (n: number, cur = "USD") => `${cur === "CNY" ? "¥" : "$"}${n.toFixed(4)}`;
const usd = (pair: any) => Number(pair?.USD ?? 0);
const rangeText = (row: any) => usd(row.max) - usd(row.min) > 1e-9
  ? `${money(usd(row.min))}–${money(usd(row.max))}` : money(usd(row.max));

export async function apply(ctx: Context) {
  let saved: Partial<Config> | null = null;
  try { saved = await ctx.config.read<Partial<Config>>("config.json"); } catch { saved = null; }
  const cfg: Config = { ...DEFAULTS, ...(saved ?? {}) };
  if (!cfg.enabled) {
    ctx.logger.info("账本插件已停用（config.json 里 enabled=false）");
    return;
  }

  const snapshot = async (days: number) => {
    const global = { ...(await loadGlobal()), include_judge_usage: cfg.include_judge_usage };
    const [rows, hourly] = await Promise.all([
      collectDays(ROOT, global, days),
      collectHours(ROOT, global),
    ]);
    return { rows, hourly, config: { days, timezone: global?.timezone ?? null, verified: VERIFIED } };
  };

  ctx.web.page("/plugins/ledger/data", async (req, res) => {
    const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
    const days = Math.min(90, Math.max(1, Number(query.get("days")) || Number(cfg.days) || 7));
    const body = JSON.stringify(await snapshot(days));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  });

  // 页面由 usage-log.ts 注册（与日志口径合并成一张）。
  const disposers: Array<() => void> = [];
  registerUsageTools(ctx, disposers);

  ctx.tools.register({
    name: "ledger_today",
    description: "查询本会话累计 token 用量。full 权限可查全实例今日各模型的 token 用量和参考金额。",
    danger: "safe",
    schema: { type: "object", properties: {}, additionalProperties: false },
    async run(_args, session) {
      if (session?.permission !== "full") {
        const summary = await sessionUsage(ctx, { id: session?.id, personaId: session?.personaId });
        const note = session?.id ? "\n范围：仅本会话，宿主提供会话累计用量。" : "";
        return { ok: summary.ok, result: usageText(summary) + note };
      }
      const global = { ...(await loadGlobal()), include_judge_usage: cfg.include_judge_usage };
      const [rows, hourly] = await Promise.all([
        collectDays(ROOT, global, 1),
        collectHours(ROOT, global),
      ]);
      const today = hourly.day;
      const lines = rows.filter((r) => r.day === today).map((r) => {
        const cost = r.exact ? money(usd(r.max)) : rangeText(r);
        return `${r.model}（${r.provider}）${r.requests} 次，入 ${r.input}、出 ${r.output}，${cost}`;
      });
      const total = hourly.hours.reduce((sum, h) => sum + h.max.USD, 0);
      return { ok: true, result: lines.length
        ? `${today}\n${lines.join("\n")}\n合计参考 ${money(total, "USD")}（价目核验 ${VERIFIED}，不是账单）`
        : `${today} 还没有记录` };
    },
  });

  ctx.logger.info("账本插件已就绪", { root: ROOT, days: cfg.days });
  return () => { for (const dispose of disposers.reverse()) { try { dispose(); } catch { /* 卸载不抛 */ } } };
}

