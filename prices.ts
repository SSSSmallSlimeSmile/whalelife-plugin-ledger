/*! 价目表：按端点 origin 选账本，再按模型名取每百万 token 的 [缓存命中, 输入, 输出]。
 *
 * 费率是「参考价」，不是账单。核价日期写进返回值，页面照原样显示。
 * 与主干 core/model-usage.ts 同一套规则；这里单独留一份，是为了让插件不依赖主干内部模块，
 * 上游改了主干也不会把插件带崩。
 */

export type CacheUsage = { hit_tokens: number | null; miss_tokens: number | null };
export type Cost = {
  currency: "CNY" | "USD";
  amount: number | null;
  min: number;
  max: number;
  price_date: string;
  period: "off_peak" | "peak_or_holiday";
};

type Rates = readonly [number, number, number];
type Book = { currency: "CNY" | "USD"; peakMultiplier?: number; anyModel?: boolean; rates: Map<string, Rates> };

const isTokens = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;

/** 缓存字段缺失就是未知；明确写 0 仍算测得 0。 */
export function cacheUsage(raw: any): CacheUsage {
  if (!raw || typeof raw !== "object" || !isTokens(raw.prompt_tokens)) return { hit_tokens: null, miss_tokens: null };
  const input = raw.prompt_tokens;
  const hits: unknown[] = [raw.prompt_cache_hit_tokens,
    raw.prompt_tokens_details && typeof raw.prompt_tokens_details === "object"
      ? raw.prompt_tokens_details.cached_tokens : undefined].filter(v => v !== undefined);
  const reportedMiss: unknown = raw.prompt_cache_miss_tokens;
  if (hits.some(v => !isTokens(v) || v > input) ||
      (reportedMiss !== undefined && (!isTokens(reportedMiss) || reportedMiss > input)))
    return { hit_tokens: null, miss_tokens: null };
  if (hits.some(v => v !== hits[0])) return { hit_tokens: null, miss_tokens: null };
  let hit = (hits[0] as number | undefined) ?? null;
  let miss = (reportedMiss as number | undefined) ?? null;
  if (hit === null && miss === null) return { hit_tokens: null, miss_tokens: null };
  if (hit !== null && miss !== null && hit + miss !== input) return { hit_tokens: null, miss_tokens: null };
  if (hit === null) hit = input - miss!;
  if (miss === null) miss = input - hit;
  return { hit_tokens: hit, miss_tokens: miss };
}

export const VERIFIED = "2026-11-16";

const deepseek: Book = {
  currency: "CNY",
  peakMultiplier: 2,
  rates: new Map<string, Rates>([
    ["deepseek-flash", [0.02, 1, 4]],
    ["deepseek-v4-flash", [0.02, 1, 4]],
    ["deepseek-v4-flash-vision-exp", [0.02, 1, 4]],
    ["deepseek-v4-pro", [0.15, 4.5, 13.5]],
  ]),
};

const mira = new Map<string, Rates>([
  ["deepseek-v4.1-flash", [0.0035, 0.135, 0.54]],
  ["claude-haiku-5.5", [0.01, 0.1, 0.5]],
  ["gpt-6.1-sol", [0.08, 1.6, 8]],
]);

const gemini: Book = {
  currency: "USD",
  rates: new Map<string, Rates>([
    ["gemini-3.1-flash-lite", [0.025, 0.25, 1.5]],
    ["gemini-3.5-flash-lite", [0.03, 0.3, 2.5]],
  ]),
};

const local: Book = { currency: "USD", anyModel: true, rates: new Map([["*", [0, 0, 0] as Rates]]) };

const books = new Map<string, Book>([
  ["https://api.deepseek.com", deepseek],
  ["https://api.mirarouter.com", { currency: "USD", rates: mira }],
  ["https://generativelanguage.googleapis.com", gemini],
  ["http://127.0.0.1:11434", local],
  ["http://localhost:11434", local],
]);

/** 算一笔参考价。端点不在表里、模型不在表里，一律返回 null——宁可不报，也不瞎报。 */
export function referenceCost(raw: any, provider: any, measuredAt: Date): Cost | null {
  if (!raw || typeof raw !== "object" || !isTokens(raw.prompt_tokens) || !isTokens(raw.completion_tokens) ||
      !Number.isFinite(measuredAt.getTime())) return null;
  if ((provider?.protocol ?? "openai-compatible") !== "openai-compatible") return null;
  let endpoint: URL;
  try { endpoint = new URL(provider?.base_url); } catch { return null; }
  const book = books.get(endpoint.origin);
  if (!book) return null;
  const freeTier = /free/i.test(String(provider?.id ?? ""));
  const cache = cacheUsage(raw);
  const rates = freeTier ? ([0, 0, 0] as Rates) : book.rates.get(String(provider?.model)) ??
    (book.anyModel ? book.rates.get("*") : undefined);
  if (!rates) return null;
  // UTC+8 固定，不依赖宿主时区。节假日不猜，峰时保留整段区间。
  const beijing = new Date(measuredAt.getTime() + 8 * 3600000);
  const weekday = beijing.getUTCDay(), hour = beijing.getUTCHours();
  const possiblePeak = !!book.peakMultiplier && weekday >= 1 && weekday <= 5 &&
    ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
  const multiplier = possiblePeak ? book.peakMultiplier! : 1;
  const known = cache.hit_tokens !== null && cache.miss_tokens !== null;
  const inputMin = known ? cache.hit_tokens! * rates[0] + cache.miss_tokens! * rates[1]
    : raw.prompt_tokens * rates[0];
  const inputMax = known ? inputMin : raw.prompt_tokens * rates[1];
  const output = raw.completion_tokens * rates[2];
  const min = (inputMin + output) / 1e6;
  const max = (inputMax + output) * multiplier / 1e6;
  return {
    currency: book.currency,
    amount: known && !possiblePeak ? min : null,
    min, max,
    price_date: VERIFIED,
    period: possiblePeak ? "peak_or_holiday" : "off_peak",
  };
}
