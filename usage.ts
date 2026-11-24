/*! 扫 memory/sessions 下的 episodes/*.jsonl，把每行 request_usage 按「日 × 模型」「小时 × 模型」聚起来。
 *
 * 只读。不写任何文件，也不碰会话本身。
 * 另有一个可选来源 memory/usage-judge.jsonl；配置 include_judge_usage 为 true 才读它。
 * 那个文件来自按难度挑模型的扩展，没有它账本一样能跑。
 */
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { referenceCost } from "./prices.ts";

const DAY_MS = 86400000;

function dayOf(instant: number, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(instant));
}

function hourOf(instant: number, timeZone: string) {
  const hour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", hourCycle: "h23",
  }).format(new Date(instant)));
  return Number.isFinite(hour) ? (hour === 24 ? 0 : hour) : 0;
}

export function judgeUsagePath(root: string) {
  return resolve(root, "memory/usage-judge.jsonl");
}

async function episodeFiles(root: string, includeJudge: boolean) {
  const base = resolve(root, "memory/sessions");
  let sessions: string[];
  const files: string[] = includeJudge ? [judgeUsagePath(root)] : [];
  try { sessions = await readdir(base); } catch { return files; }
  for (const id of sessions) {
    const dir = resolve(base, id, "episodes");
    let names: string[];
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names) if (name.endsWith(".jsonl")) files.push(resolve(dir, name));
  }
  return files;
}

type AnyUsage = { provider_id?: string; model?: string; measured_at?: string;
  input_tokens?: number; output_tokens?: number;
  cache?: { hit_tokens?: number; miss_tokens?: number } };

function money(currency: string) {
  return currency as "CNY" | "USD";
}

export type Row = {
  day: string; provider: string; model: string;
  requests: number; input: number; output: number;
  unpriced: number; exact: boolean;
  min: { CNY: number; USD: number }; max: { CNY: number; USD: number };
};

export type HourRow = Row & { hour: number };

type Provider = { id: string; base_url?: string; protocol?: string };

class Aggregator<RowType extends Row> {
  rows = new Map<string, RowType>();
  private providers: Map<string, Provider>;
  constructor(providers: Map<string, Provider>) { this.providers = providers; }
  take(key: string, make: () => RowType, usage: AnyUsage, at: number) {
    const row = this.rows.get(key) ?? make();
    row.requests += 1;
    row.input += Number.isSafeInteger(usage.input_tokens) ? usage.input_tokens! : 0;
    row.output += Number.isSafeInteger(usage.output_tokens) ? usage.output_tokens! : 0;
    const provider = this.providers.get(String(usage.provider_id));
    const hit = usage.cache?.hit_tokens, miss = usage.cache?.miss_tokens;
    const raw = {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      ...(Number.isSafeInteger(hit) && Number.isSafeInteger(miss)
        ? { prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: miss } : {}),
    };
    const cost = provider ? referenceCost(raw, { ...provider, model: usage.model }, new Date(at)) : null;
    if (!cost) row.unpriced += 1;
    else {
      const cur = money(cost.currency);
      row.min[cur] += cost.min;
      row.max[cur] += cost.max;
      if (cost.amount === null) row.exact = false;
    }
    this.rows.set(key, row);
  }
}

const emptyRow = (day: string) => ({
  day, provider: "?", model: "?", requests: 0, input: 0, output: 0, unpriced: 0, exact: true,
  min: { CNY: 0, USD: 0 }, max: { CNY: 0, USD: 0 },
});

export async function collectDays(root: string, config: any, days: number) {
  const timeZone = config?.timezone || "Australia/Brisbane";
  const providers = new Map<string, Provider>((config?.providers || []).map((p: any) => [p.id, p]));
  const wanted = new Set<string>();
  for (let i = 0; i < days; i++) wanted.add(dayOf(Date.now() - i * DAY_MS, timeZone));
  const agg = new Aggregator<Row>(providers);
  for (const file of await episodeFiles(root, config?.include_judge_usage === true)) {
    let text: string;
    try { text = await readFile(file, "utf8"); } catch { continue; }
    if (!text.includes("request_usage")) continue;
    for (const line of text.split("\n")) {
      if (!line.includes("request_usage")) continue;
      let row: any;
      try { row = JSON.parse(line); } catch { continue; }
      const usage: AnyUsage | undefined = row?.request_usage;
      if (!usage?.measured_at) continue;
      const at = Date.parse(usage.measured_at);
      if (!Number.isFinite(at)) continue;
      const day = dayOf(at, timeZone);
      if (!wanted.has(day)) continue;
      agg.take(`${day}|${usage.provider_id}|${usage.model}`, () => ({
        ...emptyRow(day),
        provider: String(usage.provider_id ?? "?"), model: String(usage.model ?? "?"),
      }), usage, at);
    }
  }
  return [...agg.rows.values()].sort((a, b) => (b.input + b.output) - (a.input + a.output));
}

export async function collectHours(root: string, config: any) {
  const timeZone = config?.timezone || "Australia/Brisbane";
  const providers = new Map<string, Provider>((config?.providers || []).map((p: any) => [p.id, p]));
  const today = dayOf(Date.now(), timeZone);
  const agg = new Aggregator<HourRow>(providers);
  for (const file of await episodeFiles(root, config?.include_judge_usage === true)) {
    let text: string;
    try { text = await readFile(file, "utf8"); } catch { continue; }
    if (!text.includes("request_usage")) continue;
    for (const line of text.split("\n")) {
      if (!line.includes("request_usage")) continue;
      let row: any;
      try { row = JSON.parse(line); } catch { continue; }
      const usage: AnyUsage | undefined = row?.request_usage;
      if (!usage?.measured_at) continue;
      const at = Date.parse(usage.measured_at);
      if (!Number.isFinite(at) || dayOf(at, timeZone) !== today) continue;
      const hour = hourOf(at, timeZone);
      agg.take(`${hour}|${usage.provider_id}|${usage.model}`, () => ({
        ...emptyRow(today), hour,
        provider: String(usage.provider_id ?? "?"), model: String(usage.model ?? "?"),
      }), usage, at);
    }
  }
  return { day: today, hours: [...agg.rows.values()].sort((a, b) => a.hour - b.hour) };
}
