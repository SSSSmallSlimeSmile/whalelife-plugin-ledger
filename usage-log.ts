/*! 用量日检：从执行日志统计每天的模型用量，并与宿主账本（只读）对账。
 *
 * 为什么存在：宿主的账本（usage_today / ledger_today）读的是会话记录里的
 * request_usage，而那份记录每轮对话只在收尾写一次——一轮里跑了十几次模型，
 * 只有最后一次的用量落进记忆。日志 logs/executions 记的是每一次请求。
 * 所以想看清钱花在哪，只能读日志；想跟账本对上，就把两个数摆在一起。
 *
 * 只读：本插件不改宿主的任何文件，只读日志、读自己的配置。
 * 读别的目录前要用户自己填路径——宿主没有公开「根目录」接口，也不该有。
 */
import type { Context } from "../../core/context.ts";
import { chartShell } from "./charts.ts";
import { readdir, readFile, mkdir } from "node:fs/promises";
import { resolve, join, dirname, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { registerConsumption, sessionUsage } from "./consumption.ts";
import { VERIFIED } from "./prices.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86400000;

export type Price = { input?: number; output?: number; cached?: number };
export type Config = {
  /** 执行日志目录，例如 <宿主目录>\logs\executions；为空时工具直接报「没配」。 */
  logDir: string;
  timezone: string;
  /** 价目：{"provider|model": {input, output, cached}}，单位 美元/百万 token。 */
  price: Record<string, Price>;
};

const DEFAULTS: Config = { logDir: "", timezone: "Australia/Brisbane", price: {} };

export type DayRow = {
  day: string;
  provider: string;
  /** 配置里的模型条目 id（如 mr-deepseek-v41-low），价目优先按它查。 */
  modelId: string;
  /** 真正发给接口的模型名（如 deepseek-v4.1-flash）。 */
  model: string;
  rounds: number;
  input: number;
  output: number;
  cached: number;
  /** 有价目才有；null 表示这一行算不出钱。 */
  cost: number | null;
};

function dayOf(instant: number, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(instant));
}

function hourOf(instant: number, timeZone: string) {
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", hourCycle: "h23",
  }).format(new Date(instant));
  const hour = Number(text);
  return Number.isFinite(hour) && hour !== 24 ? hour : 0;
}

function loadConfig(ctx: Context): Config {
  let saved: any = {};
  try { saved = (ctx.config as any)("config.json") ?? {}; } catch { saved = {}; }
  return {
    logDir: typeof saved.logDir === "string" ? saved.logDir : DEFAULTS.logDir,
    timezone: typeof saved.timezone === "string" && saved.timezone ? saved.timezone : DEFAULTS.timezone,
    price: saved.price && typeof saved.price === "object" ? { ...saved.price } : {},
  };
}

/** 日志文件名以 YYYYMMDD 开头；只挑需要的那些，别把几 GB 全读一遍。 */
function cutoffDay(now: number, days: number, timeZone: string) {
  return dayOf(now - Math.max(0, days) * DAY_MS, timeZone).replace(/-/g, "");
}

async function jsonlFiles(dir: string, since: string) {
  const out: string[] = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...await jsonlFiles(full, since)); continue; }
    if (!entry.name.endsWith(".jsonl")) continue;
    const stamp = entry.name.slice(0, 8);
    if (!/^\d{8}$/.test(stamp) || stamp < since) continue;
    out.push(full);
  }
  return out;
}

/** 一份日志 = 一次执行。按执行算，比按行算少一半的字符串比较。 */
async function readExecution(
  file: string,
  timeZone: string,
  wanted: Set<string>,
  since24 = 0,
  hourly: Map<string, { day: string; hour: number; row: DayRow }> | null = null,
) {
  const text = await readFile(file, "utf8");
  const rows: DayRow[] = [];
  let provider = "?";
  let modelId = "?";
  let model = "?";
  let bucket: DayRow | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"kind"')) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    const at = Date.parse(row?.ts);
    if (!Number.isFinite(at)) continue;
    // 归属先认，再按日期筛：跨夜执行的第一条 context 可能落在窗口外，
    // 但后面那些请求仍属于这个模型，不能因此归到「?」。
    if (row.kind === "context") {
      provider = String(row.data?.provider ?? provider);
      // 旧版宿主的 context 行只有 provider/model，没有 model_id；
      // 缺了就拿 model 名顶上，否则整段历史都会被记成「?」。
      modelId = String(row.data?.model_id ?? row.data?.model ?? modelId);
      model = String(row.data?.model ?? model);
      continue;
    }
    const day = dayOf(at, timeZone);
    if (!wanted.has(day)) continue;
    if (row.kind !== "model_result") continue;
    const usage = row?.data?.usage;
    if (!usage) continue;
    if (!bucket || bucket.day !== day || bucket.provider !== provider || bucket.modelId !== modelId) {
      bucket = { day, provider, modelId, model, rounds: 0, input: 0, output: 0, cached: 0, cost: null };
      rows.push(bucket);
    }
    bucket.rounds += 1;
    bucket.input += Number(usage.prompt_tokens) || 0;
    bucket.output += Number(usage.completion_tokens) || 0;
    bucket.cached += Number(usage.prompt_tokens_details?.cached_tokens) || 0;
    if (hourly && at >= since24) {
      const hour = hourOf(at, timeZone);
      // 键里必须带日期：24 小时窗口跨日时，同一个钟点会出现两次，混在一起就分不清哪根柱子是今天的。
      const key = `${day}|${hour}|${provider}|${modelId}`;
      let slot = hourly.get(key);
      if (!slot) {
        slot = { day, hour, row: { day, provider, modelId, model, rounds: 0, input: 0, output: 0, cached: 0, cost: null } };
        hourly.set(key, slot);
      }
      slot.row.rounds += 1;
      slot.row.input += Number(usage.prompt_tokens) || 0;
      slot.row.output += Number(usage.completion_tokens) || 0;
      slot.row.cached += Number(usage.prompt_tokens_details?.cached_tokens) || 0;
    }
  }
  return rows;
}

/** 把「钟点|provider|modelId」的桶按钟点并起来，顺手算钱。 */
type HourPart = { name: string; rounds: number; input: number; output: number; cost: number | null };
type HourSlot = { hour: number; day: string; label: string; rounds: number; input: number; output: number; cost: number | null; parts: HourPart[] };

function mergeHours(
  hourly: Map<string, { day: string; hour: number; row: DayRow }>,
  price: Record<string, Price>,
  now: number,
  timeZone: string,
): HourSlot[] {
  // 固定显示「今天」的 00:00–24:00，24 格不多不少。
  // 之前的滚动窗口（now-23h → now）在凌晨看会一头雾水，也看不出今天到底是几点花的。
  // 现在左侧永远是 00:00，还没到的小时留空。
  const today = dayOf(now, timeZone);
  const slots: HourSlot[] = [];
  const index = new Map<string, HourSlot>();
  for (let hour = 0; hour < 24; hour += 1) {
    const pad = String(hour).padStart(2, "0");
    const slot: HourSlot = { hour, day: today, label: `${pad}:00`, rounds: 0, input: 0, output: 0, cost: null, parts: [] };
    slots.push(slot);
    index.set(`${today}|${hour}`, slot);
  }
  for (const { day, hour, row } of hourly.values()) {
    const slot = index.get(`${day}|${hour}`);
    if (!slot) continue;
    const cost = costOf(row, price);
    slot.rounds += row.rounds;
    slot.input += row.input;
    slot.output += row.output;
    if (cost !== null) slot.cost = (slot.cost ?? 0) + cost;
    const name = row.modelId || row.model || row.provider || "?";
    const part = slot.parts.find((p) => p.name === name);
    if (part) {
      part.rounds += row.rounds;
      part.input += row.input;
      part.output += row.output;
      if (cost !== null) part.cost = (part.cost ?? 0) + cost;
    } else {
      slot.parts.push({ name, rounds: row.rounds, input: row.input, output: row.output, cost });
    }
  }
  for (const slot of slots) slot.parts.sort((a, b) => b.input - a.input);
  return slots;
}

function priceFor(price: Record<string, Price>, provider: string, modelId: string, model: string) {
  return price[`${provider}|${modelId}`] ?? price[`${provider}|${model}`] ?? price[modelId] ?? price[model] ?? null;
}

function costOf(row: DayRow, price: Record<string, Price>) {
  const p = priceFor(price, row.provider, row.modelId, row.model);
  if (!p) return null;
  const cached = Math.min(row.cached, row.input);
  const fresh = row.input - cached;
  const amount = (fresh * (p.input ?? 0) + cached * (p.cached ?? p.input ?? 0) + row.output * (p.output ?? 0)) / 1e6;
  return Number.isFinite(amount) ? amount : null;
}

export type Summary = {
  from: string;
  to: string;
  days: number;
  files: number;
  skipped: number;
  rounds: number;
  input: number;
  output: number;
  cached: number;
  cost: number | null;
  pricedRounds: number;
  byDay: Array<{
    day: string; rounds: number; input: number; output: number; cached: number; cost: number | null;
    /** 这一天里每个模型各消耗多少，前端据此堆叠上色。 */
    parts: Array<{ name: string; rounds: number; input: number; output: number; cost: number | null }>;
  }>;
  byModel: DayRow[];
  /** 跨天合并后的排行：同一个 provider|modelId 只占一行，排名才有意义。 */
  byModelTotal: Array<DayRow & { days: number; label: string }>;
  byHour: Array<{ hour: number; rounds: number; input: number; output: number }>;
  /** 过去 24 小时：从 now-23h 到 now，按时间升序，固定 24 格。label 带日期以便跨日区分。 */
  byHour24: Array<{
    hour: number; day: string; label: string; rounds: number; input: number; output: number; cost: number | null;
    /** 这一小时里每个模型各消耗多少，前端据此堆叠上色。 */
    parts: Array<{ name: string; rounds: number; input: number; output: number; cost: number | null }>;
  }>;
};

/**
 * 跨天合并、并且按「实际模型」合并排行：
 * 旧日志没有 model_id，只能回落到 model 名，于是同一个模型会以
 * 「mr-deepseek-v41-low」和「deepseek-v4.1-flash」两个身份各占一行。
 * 排行问的是哪个模型花钱多，按 model 名收拢才对。
 */
function totalByModel(rows: DayRow[]): Array<DayRow & { days: number; label: string }> {
  const map = new Map<string, DayRow & { days: number; label: string }>();
  // 天数按「出现过的日期」算，不能按行数累加——同一天里 low/none 各一行，会翻倍。
  const daySets = new Map<string, Set<string>>();
  for (const row of rows) {
    const label = row.model && row.model !== "?" ? row.model : row.modelId;
    const key = `${row.provider}|${label}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...row, days: 1, label });
      daySets.set(key, new Set([row.day]));
      continue;
    }
    prev.rounds += row.rounds;
    prev.input += row.input;
    prev.output += row.output;
    prev.cached += row.cached;
    if (row.cost !== null) prev.cost = (prev.cost ?? 0) + row.cost;
    daySets.get(key)!.add(row.day);
  }
  for (const [key, set] of daySets) {
    const hit = map.get(key);
    if (hit) hit.days = set.size;
  }
  return [...map.values()].sort((a, b) => b.input - a.input);
}

export async function summarize(cfg: Config, days: number, now = Date.now(), scopeSession?: string): Promise<Summary> {
  if (!cfg.logDir) throw new Error("还没配日志目录：在插件页填「执行日志目录」（<宿主目录>\\logs\\executions）再试。");
  const wanted = new Set<string>();
  for (let i = 0; i < days; i++) wanted.add(dayOf(now - i * DAY_MS, cfg.timezone));
  const since = cutoffDay(now, days, cfg.timezone);
  // 范围：给了 scopeSession 就只统计那条会话的执行目录——普通调用不得看全局。
  const allFiles = await jsonlFiles(cfg.logDir, since);
  const files = scopeSession
    ? allFiles.filter((file) => file.split(/[\\/]/).includes(scopeSession))
    : allFiles;
  const byModel = new Map<string, DayRow>();
  const byHour = new Map<number, { hour: number; rounds: number; input: number; output: number }>();
  const hourly = new Map<string, { day: string; hour: number; row: DayRow }>();
  const since24 = now - 24 * 60 * 60 * 1000;
  let scanned = 0;
  let skipped = 0;
  for (const file of files) {
    let rows: DayRow[];
    try { rows = await readExecution(file, cfg.timezone, wanted, since24, hourly); } catch { skipped += 1; continue; }
    scanned += 1;
    for (const row of rows) {
      const key = `${row.day}|${row.provider}|${row.modelId}`;
      const prev = byModel.get(key);
      if (prev) {
        prev.rounds += row.rounds; prev.input += row.input;
        prev.output += row.output; prev.cached += row.cached;
      } else byModel.set(key, { ...row });
    }
  }
  const models = [...byModel.values()];
  for (const row of models) row.cost = costOf(row, cfg.price);

  const byDayMap = new Map<string, {
    day: string; rounds: number; input: number; output: number; cached: number; cost: number | null;
    parts: Array<{ name: string; rounds: number; input: number; output: number; cost: number | null }>;
  }>();
  for (const row of models) {
    const slot = byDayMap.get(row.day) ?? { day: row.day, rounds: 0, input: 0, output: 0, cached: 0, cost: null, parts: [] };
    slot.rounds += row.rounds; slot.input += row.input; slot.output += row.output; slot.cached += row.cached;
    if (row.cost !== null) slot.cost = (slot.cost ?? 0) + row.cost;
    const pname = row.modelId && row.modelId !== "?" ? row.modelId : (row.model || row.provider || "?");
    slot.parts.push({ name: pname, rounds: row.rounds, input: row.input, output: row.output, cost: row.cost });
    byDayMap.set(row.day, slot);
  }

  const total = models.reduce((acc, row) => {
    acc.rounds += row.rounds; acc.input += row.input; acc.output += row.output; acc.cached += row.cached;
    if (row.cost !== null) { acc.cost = (acc.cost ?? 0) + row.cost; acc.pricedRounds += row.rounds; }
    return acc;
  }, { rounds: 0, input: 0, output: 0, cached: 0, cost: null as number | null, pricedRounds: 0 });

  const ordered = [...wanted].sort();
  return {
    from: ordered[0] ?? "", to: ordered[ordered.length - 1] ?? "", days,
    files: scanned, skipped,
    rounds: total.rounds, input: total.input, output: total.output, cached: total.cached,
    cost: total.cost, pricedRounds: total.pricedRounds,
    byDay: [...byDayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
    byModel: models.sort((a, b) => b.input - a.input),
    byModelTotal: totalByModel(models),
    byHour: [...byHour.values()].sort((a, b) => a.hour - b.hour),
    byHour24: mergeHours(hourly, cfg.price, now, cfg.timezone),
  };
}

/** 读账本：只调宿主的只读工具，不改任何东西。旧宿主没有这个工具就算了。 */
async function ledgerOf(ctx: Context, days: number, permission: string = "ask") {
  // 对账要调下游工具 usage_today 的权限沿调用者传，不替调用者升级成 full。
  if (permission !== "full") return { ok: false, error: "对账需要 full 权限，本次调用没有，已跳过" };
  try {
    const call = (ctx.tools as any).call;
    if (typeof call !== "function") return { ok: false, error: "宿主没有 tools.call" };
    const reply = await call("usage_today", { days }, { permission } as any);
    if (!reply || reply.ok !== true) return { ok: false, error: String(reply?.result ?? "账本没有回话") };
    return { ok: true, data: reply.result };
  } catch (error: any) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

const n = (value: number) => Math.round(value).toLocaleString("en-US");
const money = (value: number | null) => value === null ? "—" : "$" + value.toFixed(4);

function reportText(s: Summary) {
  const lines: string[] = [];
  lines.push(`用量日检 ${s.from} ~ ${s.to}（${s.days} 天，${s.files} 个执行）`);
  lines.push(`请求 ${n(s.rounds)} 次 · 输入 ${n(s.input)} · 输出 ${n(s.output)} · 缓存命中 ${n(s.cached)}（${s.input ? ((s.cached / s.input) * 100).toFixed(1) : "0"}%）`);
  lines.push(`参考金额 ${money(s.cost)}${s.pricedRounds === s.rounds ? "" : `（只算了配了价目的 ${n(s.pricedRounds)} 次）`}`);
  lines.push("按天：");
  for (const day of s.byDay) {
    lines.push(`  ${day.day}  请求 ${n(day.rounds)}  输入 ${n(day.input)}  输出 ${n(day.output)}  缓存 ${day.input ? ((day.cached / day.input) * 100).toFixed(1) : "0"}%  ${money(day.cost)}`);
  }
  lines.push("按模型：");
  for (const row of s.byModel.slice(0, 8)) {
    lines.push(`  ${row.provider}|${row.modelId}（${row.model}）  ${n(row.rounds)} 次  输入 ${n(row.input)}  ${money(row.cost)}`);
  }
  return lines.join("\n");
}

export function registerUsageTools(ctx: Context, disposers: Array<() => void>) {
  disposers.push(ctx.tools.register({
    name: "usage_daily",
    description:
      "从执行日志统计模型用量：按天、按模型给出请求次数、输入/输出 token、缓存命中率；" +
      "配了价目还会给参考金额。要的是「真实花了多少」，账本数不准，用这个。" +
      "同一份结果里带对账：宿主账本每轮只记最后一笔请求，覆盖多少一并给出。只读。",
    schema: {
      type: "object",
      properties: {
        days: { type: "integer", description: "看最近几天，默认 1，最多 60", minimum: 1, maximum: 60 },
      },
      additionalProperties: false,
    },
    danger: "safe",
    async run(args: any, session: any) {
      const days = Math.min(60, Math.max(1, Number(args?.days) || 1));
      const permission = String(session?.permission ?? "ask");
      const scopeSession = permission === "full" ? undefined : String(session?.id ?? "");
      if (permission !== "full" && !scopeSession) {
        return { text: "没有可统计的范围：当前调用既没有 full 权限，也拿不到会话 id。", summary: null };
      }
      const cfg = loadConfig(ctx);
      const summary = await summarize(cfg, days, Date.now(), scopeSession);
      const ledger = await ledgerOf(ctx, days, permission);
      const covered = ledger.ok ? estimateCoverage(summary, ledger.data) : null;
      const tail = ledger.ok
        ? `账本（每轮最后一笔）：覆盖 ${covered ?? "算不出"}`
        : `账本没读到：${ledger.error}`;
      const scopeNote = scopeSession
        ? `范围：仅本会话（${scopeSession}）`
        : "范围：全部会话（full 权限）";
      return {
        text: reportText(summary) + "\n" + scopeNote + "\n" + tail,
        summary,
        ledger,
        covered,
      };
    },
  } as any));

  registerConsumption(ctx, disposers);
  registerPage(ctx, disposers);
}

function estimateCoverage(summary: Summary, ledger: any) {
  const rows = Array.isArray(ledger) ? ledger : (ledger?.days ?? ledger?.buckets ?? []);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let requests = 0;
  let input = 0;
  for (const row of rows) {
    requests += Number(row?.requests) || 0;
    input += Number(row?.input) || 0;
  }
  if (!summary.rounds) return null;
  return `${((requests / summary.rounds) * 100).toFixed(1)}%（请求）/ ${summary.input ? ((input / summary.input) * 100).toFixed(1) : "0"}%（输入）`;
}

function registerPage(ctx: Context, disposers: Array<() => void>) {
  const web: any = ctx.web;
  if (!web || typeof web.page !== "function") return;
  const page = web.page("/plugins/ledger/", async (req: any, res: any) => {
    const url = new URL(req.url, "http://local");
    const days = Math.min(60, Math.max(1, Number(url.searchParams.get("days")) || 7));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(chartShell(loadConfig(ctx).price, VERIFIED));
  }, { title: "账本", settings: true, navigation: true });
  if (typeof page === "function") disposers.push(page);

  // 图表数据：主页只拿数字，不拿表格 HTML。
  const daysJson = web.page("/plugins/ledger/days", async (req: any, res: any) => {
    const url = new URL(req.url ?? "/", "http://local");
    const days = Math.min(60, Math.max(1, Number(url.searchParams.get("days")) || 7));
    const cfg = loadConfig(ctx);
    let payload: any;
    try { payload = { ok: true, summary: await summarize(cfg, days) }; }
    catch (e: any) { payload = { ok: false, error: String(e?.message ?? e) }; }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(payload));
  });
  if (typeof daysJson === "function") disposers.push(daysJson);

  // 设置保存：web.page 只挂 GET，POST 会 404。表单走这条 POST。
  if (typeof web.api === "function") {
    const saveRoute = web.api("/plugins/ledger/save", async (req: any, res: any) => {
      try {
        const body = await readForm(req);
        const cfg = loadConfig(ctx);
        const raw = (await ctx.config.read<Record<string, any>>("config.json").catch(() => null)) ?? {};
        const next: Config = {
          ...cfg,
          ...raw,
          logDir: String(body.logDir ?? cfg.logDir).trim(),
          timezone: String(body.timezone ?? cfg.timezone).trim() || DEFAULTS.timezone,
        };
        if (body.price) {
          try { next.price = JSON.parse(String(body.price)); } catch { next.price = cfg.price; }
        }
        await ctx.config.save("config.json", next);
        res.writeHead(303, { Location: "/plugins/ledger/" });
        res.end();
      } catch (error: any) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("保存失败：" + String(error?.message ?? error));
      }
    });
    if (typeof saveRoute === "function") disposers.push(saveRoute);
  }

  // 价目表：页面上粘贴或选文件，走这里存盘。只改 price 一项，别的字段原样留着。
  if (typeof web.api === "function") {
    const priceRoute = web.api("/plugins/ledger/price", async (req: any, res: any) => {
      const send = (code: number, payload: any) => {
        res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(payload));
      };
      try {
        const body = await readJson(req);
        const price = normalizePrice(body?.price);
        await ctx.config.save("config.json", { ...((await ctx.config.read<Record<string, any>>("config.json").catch(() => null)) ?? {}), price });
        send(200, { ok: true, count: Object.keys(price).length, verified: VERIFIED });
      } catch (e: any) {
        send(400, { ok: false, error: String(e?.message ?? e) });
      }
    });
    if (typeof priceRoute === "function") disposers.push(priceRoute);
  }

  // 明细页：原来那张表，带 1/7/30 切换。
  const detail = web.page("/plugins/ledger/detail", async (req: any, res: any) => {
    const url = new URL(req.url ?? "/", "http://local");
    const days = Math.min(60, Math.max(1, Number(url.searchParams.get("days")) || 7));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(renderShell(days));
  }, { title: "账本详情" });
  if (typeof detail === "function") disposers.push(detail);

  // 数据接口：只回 JSON，页面自己填进去。
  const data = web.page("/plugins/ledger/log", async (req: any, res: any) => {
    const url = new URL(req.url, "http://local");
    const days = Math.min(60, Math.max(1, Number(url.searchParams.get("days")) || 7));
    const cfg = loadConfig(ctx);
    let summary: Summary | null = null;
    let error = "";
    try { summary = await summarize(cfg, days); } catch (e: any) { error = String(e?.message ?? e); }
    const ledger = summary ? await ledgerOf(ctx, days) : { ok: false, error: "" };
    let sessions: any = null;
    try { sessions = await sessionUsage(ctx, days); } catch (e: any) { sessions = { ok: false, error: String(e?.message ?? e) }; }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: !error, error, html: renderBody(cfg, days, summary, error, ledger, sessions) }));
  });
  if (typeof data === "function") disposers.push(data);
}

function readForm(req: any) {
  return new Promise<Record<string, any>>((done, fail) => {
    let text = "";
    req.on("data", (chunk: any) => { text += chunk; });
    req.on("end", () => {
      try {
        if (!text.trim()) return done({});
        const type = String(req.headers?.["content-type"] ?? "");
        if (type.includes("application/json")) return done(JSON.parse(text));
        const out: Record<string, string> = {};
        for (const [key, value] of new URLSearchParams(text)) out[key] = value;
        done(out);
      } catch (error: any) {
        fail(new Error("解析请求体失败：" + (error?.message ?? error)));
      }
    });
    req.on("error", () => fail(new Error("读取请求体失败")));
  });
}

function readJson(req: any) {
  return new Promise<any>((done, fail) => {
    let text = "";
    req.on("data", (chunk: any) => { text += chunk; });
    req.on("end", () => {
      try { done(text.trim() ? JSON.parse(text) : {}); }
      catch (e: any) { fail(new Error("JSON 解析失败：" + (e?.message ?? e))); }
    });
    req.on("error", () => fail(new Error("读取请求体失败")));
  });
}

/** 价目只认 {"键": {input, output, cached}}，单位 美元/百万 token；非法值直接拒，不静默改。 */
function normalizePrice(input: any): Record<string, Price> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("price 必须是一个对象");
  const keys = Object.keys(input);
  if (!keys.length) throw new Error("价目表是空的，至少留一条");
  if (keys.length > 200) throw new Error(`条目太多（${keys.length}），最多 200 条`);
  const out: Record<string, Price> = {};
  for (const key of keys) {
    const name = key.trim();
    if (!name || name.length > 120) throw new Error(`键名不合规：${key}`);
    const row = (input as any)[key];
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`${name} 的值必须是对象`);
    const clean: Price = {};
    for (const field of ["input", "output", "cached"] as const) {
      const value = (row as any)[field];
      if (value === undefined || value === null || value === "") continue;
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0 || num > 1e6) throw new Error(`${name} 的 ${field} 不是有效单价：${value}`);
      clean[field] = num;
    }
    if (clean.input === undefined && clean.output === undefined) throw new Error(`${name} 至少要填 input 或 output`);
    out[name] = clean;
  }
  return out;
}

function readBody(req: any) {
  return new Promise<Record<string, string>>((resolveBody) => {
    let text = "";
    req.on("data", (chunk: any) => { text += chunk; });
    req.on("end", () => {
      const out: Record<string, string> = {};
      try {
        for (const [key, value] of new URLSearchParams(text)) out[key] = value;
      } catch { /* 空体 */ }
      resolveBody(out);
    });
    req.on("error", () => resolveBody({}));
  });
}

function renderSessions(sessions: any): string {
  if (!sessions?.ok) {
    return `<h2>会话累计</h2><div class="err">读不到：${esc(sessions?.error ?? "宿主没有 sessions.context")}</div>`;
  }
  const rows = Array.isArray(sessions.sessions) ? sessions.sessions : [];
  const c = sessions.chat ?? { requests: 0, input_tokens: 0, output_tokens: 0 };
  let out = `<h2>会话累计</h2>
<p class="sub">宿主 sessions.context() 给的是每个会话的全量计数，比账本准（后者每轮只记最后一笔）。${esc(sessions.persona ?? "")} · ${rows.length} 个会话 · 请求 <b>${n(c.requests)}</b> 次 · 输入 <b>${n(c.input_tokens)}</b> · 输出 <b>${n(c.output_tokens)}</b></p>`;
  if (!rows.length) return out;
  out += `<table><thead><tr><th>会话</th><th>请求</th><th>输入</th><th>输出</th></tr></thead><tbody>`;
  for (const row of rows.slice(0, 20)) {
    const chat = row.chat ?? { requests: 0, input_tokens: 0, output_tokens: 0 };
    out += `<tr><td>${esc(row.name)}\n<span style="opacity:.55">${esc(row.id)}</span></td><td>${n(chat.requests)}</td><td>${n(chat.input_tokens)}</td><td>${n(chat.output_tokens)}</td></tr>`;
  }
  out += `</tbody></table>`;
  return out;
}

function esc(value: unknown) {
  return String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

const HEAD = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>账本</title>
<style>
:root{color-scheme:light dark}
body{font:14px/1.6 system-ui,"Segoe UI",sans-serif;margin:0;padding:20px 22px 40px;max-width:1000px}
h1{font-size:18px;margin:0 0 4px}\nh2{font-size:14px;margin:22px 0 6px}
p.sub{margin:0 0 18px;opacity:.65;font-size:13px}
table{border-collapse:collapse;width:100%;margin:8px 0 22px;font-variant-numeric:tabular-nums}
th,td{padding:6px 10px;border-bottom:1px solid rgba(128,128,128,.28);text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}
th{font-weight:600;font-size:12.5px;opacity:.75;border-bottom-width:1px}
.bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 16px}
.bar a{padding:5px 11px;border:1px solid rgba(128,128,128,.4);border-radius:6px;text-decoration:none;color:inherit;font-size:13px}
.bar a.on{background:#5b46d6;border-color:#5b46d6;color:#fff}
.warn{padding:10px 12px;border-left:3px solid #d29a2a;background:rgba(210,154,42,.1);border-radius:4px;margin:0 0 18px;font-size:13px}
.err{padding:10px 12px;border-left:3px solid #d24a4a;background:rgba(210,74,74,.1);border-radius:4px}
label{display:block;font-size:12.5px;opacity:.75;margin:10px 0 3px}
input,textarea{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid rgba(128,128,128,.4);border-radius:5px;font:13px/1.5 ui-monospace,Consolas,monospace;background:transparent;color:inherit}
button{margin-top:12px;padding:7px 16px;border:0;border-radius:6px;background:#5b46d6;color:#fff;font-size:13px;cursor:pointer}
details{margin:0 0 18px}summary{cursor:pointer;font-size:13px;opacity:.8}
</style>`;

const TABS = (days: number) =>
  [1, 7, 30].map((d) => `<a class="${d === days ? "on" : ""}" href="?days=${d}">${d} 天</a>`).join("");

function renderBody(cfg: Config, days: number, summary: Summary | null, error: string, ledger: any, sessions?: any) {
  let body = "";
  if (error) {
    body += `<div class="err">${esc(error)}</div>`;
  } else if (summary) {
    const rate = summary.input ? ((summary.cached / summary.input) * 100).toFixed(1) : "0.0";
    body += `<p class="sub">${esc(summary.from)} ~ ${esc(summary.to)} · ${summary.files} 个执行 · 请求 <b>${n(summary.rounds)}</b> 次 · 输入 <b>${n(summary.input)}</b> · 输出 <b>${n(summary.output)}</b> · 缓存命中 <b>${rate}%</b> · 参考 <b>${money(summary.cost)}</b></p>`;
    body += `<div class="warn">账本每轮对话只记最后一笔请求，日志记每一次。要看真实花销用这张表；想说明差在哪，看 <code>usage_daily</code> 结果末尾的对账行${
      ledger?.ok ? `（这次读出：${esc(JSON.stringify(ledger.data)).slice(0, 200)}）` : ""}</div>`;
    body += `<table><thead><tr><th>日期</th><th>请求</th><th>输入</th><th>输出</th><th>缓存命中</th><th>参考金额</th></tr></thead><tbody>`;
    for (const day of summary.byDay) {
      body += `<tr><td>${esc(day.day)}</td><td>${n(day.rounds)}</td><td>${n(day.input)}</td><td>${n(day.output)}</td><td>${day.input ? ((day.cached / day.input) * 100).toFixed(1) : "0.0"}%</td><td>${money(day.cost)}</td></tr>`;
    }
    body += `</tbody></table>`;
    body += `<table><thead><tr><th>模型</th><th>请求</th><th>输入</th><th>缓存</th><th>输出</th><th>参考金额</th></tr></thead><tbody>`;
    for (const row of summary.byModel) {
      body += `<tr><td>${esc(row.provider)}|${esc(row.modelId)} <span style="opacity:.6">${esc(row.model)}</span></td><td>${n(row.rounds)}</td><td>${n(row.input)}</td><td>${n(row.cached)}</td><td>${n(row.output)}</td><td>${money(row.cost)}</td></tr>`;
    }
    body += `</tbody></table>`;
  }
  if (sessions) {
    body += renderSessions(sessions);
  }
  body += `<details><summary>设置</summary><form method="post" action="/plugins/ledger/save">
<label>执行日志目录（必填）</label>
<input name="logDir" value="${esc(cfg.logDir)}" placeholder="<宿主目录>\\logs\\executions">
<label>时区</label>
<input name="timezone" value="${esc(cfg.timezone)}">
<label>价目（JSON，单位 美元/百万 token；键写 provider|模型条目id 或 provider|模型名，留空就不算钱）</label>
<textarea name="price" rows="4">${esc(JSON.stringify(cfg.price, null, 2))}</textarea>
<button type="submit">保存</button>
</form></details>`;
  return body;
}

// 先把骨架吐出去（几十毫秒），数据再走 /data 取。
// 原来整页要扫几千个执行文件，7 秒才响应；宿主把插件页放在 iframe 里，
// 7 秒足够父页面重渲染几次、把这个 iframe 换掉，于是永远是白卡。
function renderShell(days: number) {
  return `${HEAD}<body><p class="sub" style="margin:0 0 6px"><a href="/plugins/ledger/" style="color:inherit">← 回图表</a></p><h1>账本 · 明细</h1>
<p class="sub">读执行日志统计真实用量，只读；不改宿主的任何文件。金额按你自己填的价目算，不是账单。</p>
<div class="bar">${TABS(days)}</div>
<div id="data"><p class="sub">正在统计…</p></div>
<script>
const box=document.getElementById("data");
fetch("/plugins/ledger/log?days=${days}",{cache:"no-store"})
  .then(r=>r.json())
  .then(j=>{box.innerHTML=j.ok?j.html:'<div class="err">'+(j.error||"未知")+'</div>';})
  .catch(e=>{box.innerHTML='<div class="err">加载失败：'+e+'</div>';});
</script></body></html>`;
}

export { summarize as __summarize, costOf as __costOf };
