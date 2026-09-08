// usage-sidecar.mjs — dsh-usage-stats: desktop badge data sidecar.
//
// Self-contained: folds the DSH session logs (~/.dsh/sessions) into per-day /
// per-model token buckets + estimated cost, and prints one JSON line to stdout
// on every recompute (startup + per poll interval) so the Tauri shell can emit
// it to the in-window usage panel. Reads ~/.dsh/storages/usage-pricing.json for
// prices + exchange rate (re-read each emit so edits apply live).
//
// Persists raw per-session aggregates in usage-cache.json. On later starts it
// re-reads only logs whose size/mtime/path changed; deleted logs keep their
// cached aggregates by design. Prices are always recomputed from raw usage.
//
// Print protocol: one JSON object per line, e.g.
//   {"today":{"date":"2026-08-19","cny":12.34,"usd":1.714,"requests":89,
//             "hourly":[{hour,usd,requests,input,cacheRead,cacheWrite,output}×24],
//             "providers":[{provider,usd,requests,...,hourly:[...]}]},
//    "recent":[{date,usd,requests,"providers":[{provider,usd,requests,...}]}],
//    "exchangeRate":7.2,"totalCurrency":"usd"}
// Every `usd` field holds the amount in the configured total currency
// (totalCurrency: "usd" | "cny"); `cny` is always the CNY badge value.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const POLL_MS = Number(process.env.DSH_USAGE_POLL_MS || 3000);
const UNKNOWN = "unknown";

// ── paths ───────────────────────────────────────────────────────────────────
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}
const sessionsRoot = () => join(dshHome(), "sessions");
const pricingPath = () => join(dshHome(), "storages", "usage-pricing.json");

// ── zstd ─────────────────────────────────────────────────────────────────────
function decodeMultiFrame(buf) {
  const starts = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) {
    starts.push(i);
    i += 1;
  }
  if (starts.length === 0) return buf.toString("utf8");
  let out = "";
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    out += zstdDecompressSync(buf.subarray(starts[k], end)).toString("utf8");
  }
  return out;
}

// ── pricing ─────────────────────────────────────────────────────────────────
// The default template written on first run (no usage-pricing.json yet). This
// mirrors the current working configuration, so a fresh user starts with it.
const DEFAULT_TEMPLATE = {
  exchangeRate: 6.74,
  default: { inputPerMillion: 1.5, cacheReadPerMillion: 0.05, cacheWritePerMillion: 0, outputPerMillion: 4.5, currency: "cny" },
  totalCurrency: "cny",
  multiplier: 1,
  pollMs: 3000,
  overrides: {
    "deepseek-v4-flash": {
      inputPerMillion: 1.5,
      cacheReadPerMillion: 0.05,
      cacheWritePerMillion: 0,
      outputPerMillion: 4.5,
      currency: "cny",
      multiplier: 1,
      timeOfUse: { enabled: true, peakMultiplier: 2, valleyMultiplier: 1, peakRanges: [[9, 12], [14, 18]], days: "weekday" },
    },
    "deepseek-v4-flash-vision-exp": {
      inputPerMillion: 1.5,
      cacheReadPerMillion: 0.05,
      cacheWritePerMillion: 0,
      outputPerMillion: 4.5,
      currency: "cny",
      multiplier: 1,
      timeOfUse: { enabled: true, peakMultiplier: 2, valleyMultiplier: 1, peakRanges: [[9, 12], [14, 18]], days: "weekday" },
    },
    "deepseek-v4-pro": {
      inputPerMillion: 4.5,
      cacheReadPerMillion: 0.15,
      cacheWritePerMillion: 0,
      outputPerMillion: 13.5,
      currency: "cny",
      multiplier: 1,
      timeOfUse: { enabled: true, peakMultiplier: 2, valleyMultiplier: 1, peakRanges: [[9, 12], [14, 18]], days: "weekday" },
    },
  },
};

function loadPricing() {
  const p = pricingPath();
  if (!existsSync(p)) {
    // First run: generate the default template so the user starts with it.
    try {
      mkdirSync(join(dshHome(), "storages"), { recursive: true });
      writeFileSync(p, JSON.stringify(DEFAULT_TEMPLATE, null, 2));
    } catch {
      // read-only home: fall through to defaults
    }
    return DEFAULT_TEMPLATE;
  }
  try {
    const u = JSON.parse(readFileSync(p, "utf8"));
    return {
      exchangeRate: u.exchangeRate ?? DEFAULT_TEMPLATE.exchangeRate,
      default: { ...DEFAULT_TEMPLATE.default, ...(u.default ?? {}) },
      // overrides are the user's explicit set — never merge template rows back
      // in, or a model the user deleted would silently reappear.
      overrides: u.overrides ?? {},
      timeOfUse: u.timeOfUse,
      pollMs: u.pollMs,
      multiplier: u.multiplier ?? DEFAULT_TEMPLATE.multiplier,
      contextMultiplier: u.contextMultiplier,
      totalCurrency: u.totalCurrency ?? DEFAULT_TEMPLATE.totalCurrency,
    };
  } catch {
    return DEFAULT_TEMPLATE;
  }
}

const PRICE_KEYS = ["inputPerMillion", "cacheReadPerMillion", "cacheWritePerMillion", "outputPerMillion"];

// Match keys in priority order: a pure model name (no provider) wins, then the
// exact provider|model, then provider|* and *|model wildcards. This lets a
// single config row like "deepseek-v4-flash" apply to every provider.
function matchKeys(provider, model) {
  const keys = [];
  if (model) keys.push(model); // pure model name
  if (provider && model) keys.push(`${provider}|${model}`);
  if (provider) keys.push(`${provider}|*`);
  if (model) keys.push(`*|${model}`);
  return keys;
}

function resolvePrice(pricing, provider, model) {
  const out = {};
  for (const k of PRICE_KEYS) {
    out[k] = pricing.default?.[k] ?? 0;
    for (const key of matchKeys(provider, model)) {
      const row = pricing.overrides?.[key];
      if (row && row[k] != null) {
        out[k] = row[k];
        break;
      }
    }
  }
  return out;
}

// Per-model time-of-use: a row's own timeOfUse wins (model-name row first),
// otherwise the global one.
function modelTimeOfUse(pricing, provider, model) {
  for (const k of matchKeys(provider, model)) {
    const row = pricing.overrides?.[k];
    if (row && row.timeOfUse) return row.timeOfUse;
  }
  return pricing.timeOfUse;
}

// Per-model multiplier applied to the whole cost (model-name row wins,
// otherwise the global `multiplier`, default 1).
function modelMultiplier(pricing, provider, model) {
  for (const k of matchKeys(provider, model)) {
    const row = pricing.overrides?.[k];
    if (row && row.multiplier != null) return row.multiplier;
  }
  return pricing.multiplier ?? 1;
}

// Per-model context multiplier: an override row wins, otherwise use the
// default-row rule. The rule applies only when a request's input plus cache
// tokens are strictly above its threshold.
function modelContextMultiplier(pricing, provider, model) {
  for (const k of matchKeys(provider, model)) {
    const row = pricing.overrides?.[k];
    if (row && row.contextMultiplier != null) return row.contextMultiplier;
  }
  return pricing.contextMultiplier;
}

// Per-model price currency: an override row's own currency wins (model-name
// row first), otherwise the default row's currency, defaulting to CNY.
function resolveCurrency(pricing, provider, model) {
  for (const k of matchKeys(provider, model)) {
    const row = pricing.overrides?.[k];
    if (row && row.currency) return row.currency;
  }
  return pricing.default?.currency || "cny";
}

// The currency every internal total is expressed in: `totalCurrency` config
// ("cny" default | "usd"). When rows are priced in the same currency no
// exchange rate is involved; only cross-currency rows use the live rate.
function totalCurrencyOf(pricing) {
  return pricing.totalCurrency === "usd" ? "usd" : "cny";
}

// Convert a cost quoted in `from` currency to the configured total currency.
// Same-currency conversion is a no-op (no exchange rate needed); otherwise
// CNY→USD divides and USD→CNY multiplies by the live rate.
function convertCost(cost, from, pricing) {
  const total = totalCurrencyOf(pricing);
  if (from === total) return cost;
  return from === "cny" ? cost / (pricing.exchangeRate || 1) : cost * (pricing.exchangeRate || 1);
}

function tokenCost(tokens, price) {
  return (
    ((Number(tokens.input) || 0) / 1e6) * price.inputPerMillion +
    ((Number(tokens.cacheRead) || 0) / 1e6) * price.cacheReadPerMillion +
    ((Number(tokens.cacheWrite) || 0) / 1e6) * price.cacheWritePerMillion +
    ((Number(tokens.output) || 0) / 1e6) * price.outputPerMillion
  );
}

// DSH records uncached input and cache usage as disjoint values. Their sum is
// the input context used by its own tiered-price calculation.
function contextTokens(tokens) {
  return (Number(tokens.input) || 0) + (Number(tokens.cacheRead) || 0) + (Number(tokens.cacheWrite) || 0);
}

// Token count parser: accepts a plain number, a numeric string, or a compact
// string with a K / M / B suffix (case-insensitive, optional whitespace), e.g.
// "128000", "128K", "1.5M", "2b". Returns NaN for anything unparseable.
function parseTokenCount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const text = String(value ?? "").trim();
  if (!text) return NaN;
  const m = /^(\d+(?:\.\d+)?)\s*([kKmMbB]?)$/.exec(text);
  if (!m) return NaN;
  const suffix = m[2] ? m[2].toLowerCase() : "";
  const scale = suffix === "k" ? 1e3 : suffix === "m" ? 1e6 : suffix === "b" ? 1e9 : 1;
  return parseFloat(m[1]) * scale;
}

function contextMultiplierFor(pricing, provider, model, tokens) {
  const rule = modelContextMultiplier(pricing, provider, model);
  const threshold = parseTokenCount(rule?.threshold);
  const multiplier = Number(rule?.multiplier);
  if (!Number.isFinite(threshold) || threshold <= 0 || !Number.isFinite(multiplier) || multiplier <= 0) return 1;
  return contextTokens(tokens) > threshold ? multiplier : 1;
}

// Cost of a per-request usage record: time-of-use, model multiplier and the
// context-tier rule all apply per request.
function usageCostUsd(tokens, provider, model, hour, pricing, weekday) {
  const price = resolvePrice(pricing, provider, model);
  const timeMultiplier = multiplierFor(weekday, hour, modelTimeOfUse(pricing, provider, model));
  const modelMultiplierValue = modelMultiplier(pricing, provider, model);
  const contextMultiplierValue = contextMultiplierFor(pricing, provider, model, tokens);
  const cost = tokenCost(tokens, price) * timeMultiplier * modelMultiplierValue * contextMultiplierValue;
  return convertCost(cost, resolveCurrency(pricing, provider, model), pricing);
}

// Legacy cost for aggregate token totals (v1 caches, or the pre-upgrade fold):
// no per-request context is known, so it prices exactly as before the
// context-tier feature (time-of-use × model multiplier only).
function legacyCostUsd(tokens, provider, model, hour, pricing, weekday) {
  const price = resolvePrice(pricing, provider, model);
  const timeMultiplier = multiplierFor(weekday, hour, modelTimeOfUse(pricing, provider, model));
  const cost = tokenCost(tokens, price) * timeMultiplier * modelMultiplier(pricing, provider, model);
  return convertCost(cost, resolveCurrency(pricing, provider, model), pricing);
}

/// Per-hour cost array (0..23) for a bucket in a single pass over its records,
/// so the day chart and provider summaries never rescan the per-request list
/// once per hour. New caches retain per-request usage and evaluate the
/// context-tier multiplier exactly; legacy cache entries use their aggregate
/// tokens and retain their former (pre-context-tier) pricing behavior.
function bucketHourlyCostsUsd(bucket, pricing, weekday) {
  const out = new Array(24).fill(0);
  if (Array.isArray(bucket.usageRecords)) {
    for (const usage of bucket.usageRecords) {
      let hour = Number.isInteger(usage?.hour) ? usage.hour : flatHour();
      if (hour < 0 || hour > 23) hour = flatHour();
      out[hour] += usageCostUsd(usage, bucket.provider, bucket.model, hour, pricing, weekday);
    }
    return out;
  }
  for (let hour = 0; hour < 24; hour++) {
    const tokens = bucket.hourly?.[hour];
    out[hour] = tokens ? legacyCostUsd(tokens, bucket.provider, bucket.model, hour, pricing, weekday) : 0;
  }
  return out;
}

function costUsd(bucket, pricing, weekday = flatWeekday()) {
  // Aggregate-shaped bucket (no hourly splits, no per-request list): price the
  // whole bucket flat at the current hour, as before.
  if (!Array.isArray(bucket.hourly) && !Array.isArray(bucket.usageRecords)) {
    return legacyCostUsd(bucket, bucket.provider, bucket.model, flatHour(), pricing, flatWeekday());
  }
  let total = 0;
  for (const hourCost of bucketHourlyCostsUsd(bucket, pricing, weekday)) total += hourCost;
  return total;
}

// ── time-of-use (peak / valley) pricing ──────────────────────────────────────
const OFF = -new Date().getTimezoneOffset(); // host local, minutes east
function dayKey(ms) {
  const d = new Date(ms + OFF * 60000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function localHour(ms) {
  return new Date(ms + OFF * 60000).getUTCHours();
}
function flatHour() {
  return new Date().getHours(); // approximate for buckets without hourly splits
}
/// Weekday 1=Monday … 7=Sunday from a JS Date (getDay(): 0=Sunday … 6=Saturday).
function weekdayOf(d) {
  return (d.getDay() + 6) % 7 + 1;
}
function flatWeekday() {
  return weekdayOf(new Date()); // approximate for buckets without hourly splits
}
/// Weekday (1=Mon..7=Sun) of a local "YYYY-MM-DD" day key.
function weekdayFromDayKey(dk) {
  const [y, m, d] = String(dk).split("-").map(Number);
  return weekdayOf(new Date(y, m - 1, d));
}
function initHourly() {
  return Array.from({ length: 24 }, () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 }));
}
/// Whether a weekday (1=Mon..7=Sun) matches a `days` rule. Spec: "all" /
/// "weekday" / "weekend" / an array like [1,2,3,4,5]; missing or unknown → all
/// days (keeps old configs behaving exactly as before).
function dayMatches(weekday, days) {
  if (days == null || days === "") return true;
  if (typeof days === "string") {
    const s = days.trim().toLowerCase();
    if (s === "all") return true;
    if (s === "weekday" || s === "workday") return weekday >= 1 && weekday <= 5;
    if (s === "weekend") return weekday >= 6; // 6=Sat, 7=Sun
    return true; // unknown string: lenient, treat as all days
  }
  if (Array.isArray(days)) return days.some((d) => Number(d) === weekday);
  return true;
}
/**
 * Peak/valley multiplier for a local hour on a given weekday. Flat (1) when
 * time-of-use is off, or when the day doesn't match the `days` rule; peak on
 * matching days inside peakRanges; valley otherwise.
 */
function multiplierFor(weekday, hour, tou) {
  if (!tou || !tou.enabled) return 1;
  if (!dayMatches(weekday, tou.days)) return 1; // days 不匹配 → 原价
  for (const range of tou.peakRanges || []) {
    if (!Array.isArray(range) || range.length < 2) continue; // tolerate malformed entries
    const [s, e] = range;
    if (typeof s === "number" && typeof e === "number" && hour >= s && hour < e) return Math.max(1, tou.peakMultiplier ?? 1); // peak multiplier is a surcharge: never below 1
  }
  return tou.valleyMultiplier ?? 1;
}

// Persistent cache: raw token/request aggregates are stored per session. Prices
// are intentionally not cached, so changing pricing can be applied immediately.
const CACHE_VERSION = 2;
const usageCachePath = () => join(dshHome(), "storages", "usage-cache.json");
const sessionRecords = new Map();
// days: Map<date, Map<"provider|model", bucket>>
const days = new Map();
// cursors: Map<sessionId, { seq, provider, model, fileSize, fileMtimeMs }>
const cursors = new Map();

function emptyBucket(provider, model) {
  return {
    provider,
    model,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    requests: 0,
    estimatedCostUsd: 0,
    hourly: initHourly(),
    usageRecords: [],
  };
}

function addBucket(target, source) {
  target.input += Number(source?.input) || 0;
  target.cacheRead += Number(source?.cacheRead) || 0;
  target.cacheWrite += Number(source?.cacheWrite) || 0;
  target.output += Number(source?.output) || 0;
  target.requests += Number(source?.requests) || 0;
  if (!Array.isArray(target.hourly)) target.hourly = initHourly();
  if (Array.isArray(source?.hourly)) {
    for (let hour = 0; hour < 24; hour++) {
      const from = source.hourly[hour];
      const to = target.hourly[hour];
      if (!from || !to) continue;
      to.input += Number(from.input) || 0;
      to.cacheRead += Number(from.cacheRead) || 0;
      to.cacheWrite += Number(from.cacheWrite) || 0;
      to.output += Number(from.output) || 0;
      to.requests += Number(from.requests) || 0;
    }
  }
  // A missing per-request list denotes a v1 cache aggregate. Do not mix a
  // partial list with unknown records, or the context-tier price would omit
  // part of the bucket. Appending is looped, never spread: a single day bucket
  // can hold hundreds of thousands of requests, and spread pushes would throw
  // a RangeError long before that.
  if (!Array.isArray(target.usageRecords) || !Array.isArray(source?.usageRecords)) {
    target.usageRecords = null;
  } else {
    for (const usage of source.usageRecords) {
      if (usage && typeof usage === "object") target.usageRecords.push(usage);
    }
  }
}

function mergeSessionDays() {
  days.clear();
  for (const record of sessionRecords.values()) {
    for (const [date, sourceDay] of record.days ?? []) {
      let targetDay = days.get(date);
      if (!targetDay) {
        targetDay = new Map();
        days.set(date, targetDay);
      }
      for (const [key, source] of sourceDay) {
        const target = targetDay.get(key) ?? emptyBucket(source.provider, source.model);
        addBucket(target, source);
        targetDay.set(key, target);
      }
    }
  }
}

function deserializeSession(record) {
  if (!record || typeof record !== "object" || !record.days || typeof record.days !== "object") return null;
  const daysMap = new Map();
  for (const [date, sourceDay] of Object.entries(record.days)) {
    if (!sourceDay || typeof sourceDay !== "object") continue;
    const dayMap = new Map();
    for (const [key, source] of Object.entries(sourceDay)) {
      if (!source || typeof source !== "object") continue;
      const bucket = emptyBucket(String(source.provider ?? UNKNOWN), String(source.model ?? UNKNOWN));
      addBucket(bucket, source);
      dayMap.set(key, bucket);
    }
    daysMap.set(date, dayMap);
  }
  return {
    path: String(record.path ?? ""),
    fileSize: Number(record.fileSize) || 0,
    fileMtimeMs: Number(record.fileMtimeMs) || 0,
    seq: Number(record.seq) || -1,
    provider: record.provider ?? null,
    model: record.model ?? null,
    days: daysMap,
  };
}

function loadUsageCache() {
  try {
    const raw = JSON.parse(readFileSync(usageCachePath(), "utf8"));
    if (!raw.sessions || typeof raw.sessions !== "object") return;
    // Migrate the v1 cache (pre-context-tier) instead of dropping it: its
    // aggregates keep the history of session logs that were already deleted.
    // Existing logs are re-folded into v2 rows right after, so pricing (and
    // the context-tier rule) becomes exact for everything still on disk.
    // Unknown future versions are left untouched.
    const migrate = raw.version === 1;
    if (raw.version !== CACHE_VERSION && !migrate) return;
    for (const [sessionId, source] of Object.entries(raw.sessions)) {
      const record = deserializeSession(source);
      if (!record) continue;
      sessionRecords.set(sessionId, record);
      cursors.set(sessionId, {
        seq: record.seq,
        provider: record.provider,
        model: record.model,
        fileSize: record.fileSize,
        fileMtimeMs: record.fileMtimeMs,
        path: record.path,
      });
    }
    mergeSessionDays();
    // Force every log still on disk to be re-read once: foldSession replaces
    // its session record (and legacy buckets) with fresh v2 rows.
    if (migrate) cursors.clear();
  } catch {
    // Missing or corrupt cache is safe: the normal log scan rebuilds it.
  }
}

function serializeSession(record) {
  const outDays = {};
  for (const [date, sourceDay] of record.days ?? []) {
    outDays[date] = {};
    for (const [key, bucket] of sourceDay) {
      const { estimatedCostUsd, ...raw } = bucket;
      outDays[date][key] = raw;
    }
  }
  return {
    path: record.path,
    fileSize: record.fileSize,
    fileMtimeMs: record.fileMtimeMs,
    seq: record.seq,
    provider: record.provider,
    model: record.model,
    days: outDays,
  };
}

function saveUsageCache() {
  const path = usageCachePath();
  let temp = null;
  try {
    mkdirSync(join(dshHome(), "storages"), { recursive: true });
    const sessions = {};
    for (const [sessionId, record] of sessionRecords) sessions[sessionId] = serializeSession(record);
    // Include time and entropy so a restarted sidecar never reuses a stale
    // temporary filename whose handle may still be held by another process.
    temp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    writeFileSync(temp, JSON.stringify({ version: CACHE_VERSION, sessions }));
    try {
      renameSync(temp, path);
      temp = null;
    } catch (renameError) {
      // Windows cannot replace an existing file with renameSync. Remove the
      // old cache only after the complete temporary file has been written.
      try {
        unlinkSync(path);
        renameSync(temp, path);
        temp = null;
      } catch (replaceError) {
        throw replaceError ?? renameError;
      }
    }
  } catch (err) {
    if (temp) {
      try {
        unlinkSync(temp);
      } catch {
        // Best-effort cleanup only.
      }
    }
    process.stderr.write("usage sidecar: cache save failed: " + ((err && err.message) || err) + "\n");
  }
}

const SESSION_LOG_RE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/;

function sessionLogParent(file) {
  const index = Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/"));
  return index >= 0 ? file.slice(0, index) : "";
}

function sessionLogRank(file) {
  const index = Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/"));
  const name = index >= 0 ? file.slice(index + 1) : file;
  const match = SESSION_LOG_RE.exec(name);
  if (!match) return -1;
  return (Number(match[1]) || 0) * 2 + (name.endsWith(".zstd") ? 1 : 0);
}

function logFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) logFiles(p, out);
    else if (SESSION_LOG_RE.test(e.name)) out.push(p);
  }
  // dsh may leave older artifacts beside a migrated session.vN log. They are
  // generations of the same session, not separate sessions to add. Select the
  // highest generation per session directory so future v3/v4/... files work.
  if (dir === sessionsRoot()) {
    const best = new Map();
    for (const file of out) {
      const parent = sessionLogParent(file);
      const current = best.get(parent);
      if (!current || sessionLogRank(file) > sessionLogRank(current)) best.set(parent, file);
    }
    return out.filter((file) => best.get(sessionLogParent(file)) === file);
  }
  return out;
}

function sessionIdFromLogPath(p) {
  return p.split(/[\\/]/).slice(-2, -1)[0] ?? p;
}

function foldSession(file) {
  const sessionId = sessionIdFromLogPath(file);
  let metadata;
  try {
    const stat = statSync(file);
    metadata = { size: stat.size, mtimeMs: stat.mtimeMs || 0 };
  } catch {
    return false;
  }
  const cur = cursors.get(sessionId);
  if (cur && cur.fileSize === metadata.size && cur.fileMtimeMs === metadata.mtimeMs && cur.path === file) return false;
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    return false;
  }
  const text = /\.zstd$/i.test(file) ? decodeMultiFrame(buf) : buf.toString("utf8");
  const lines = text.split("\n").filter(Boolean);
  const sessionDays = new Map();
  let provider = null;
  let model = null;
  let maxSeq = -1;

  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const seq = typeof ev?.seq === "number" ? ev.seq : -1;
    if (seq > maxSeq) maxSeq = seq;
    const t = ev.type;
    const d = ev.data ?? {};
    if (t === "request/header") {
      const c = d.header?.config ?? {};
      provider = c.provider ?? d.provider ?? null;
      model = c.model ?? d.model ?? null;
    } else if (t === "request/context") {
      provider = d.provider ?? provider;
      model = d.model ?? model;
    } else if (t === "assistant/message") {
      const u = d.usage;
      if (u && typeof u === "object") {
        const pm = provider ?? UNKNOWN;
        const mm = model ?? UNKNOWN;
        const key = `${pm}|${mm}`;
        const date = dayKey(ev.time);
        let dayObj = sessionDays.get(date);
        if (!dayObj) {
          dayObj = new Map();
          sessionDays.set(date, dayObj);
        }
        const b = dayObj.get(key) ?? emptyBucket(pm, mm);
        const inp = Number(u.inputTokens) || 0;
        const cr = Number(u.cacheReadTokens) || 0;
        const cw = Number(u.cacheWriteTokens) || 0;
        const out = Number(u.outputTokens) || 0;
        b.input += inp;
        b.cacheRead += cr;
        b.cacheWrite += cw;
        b.output += out;
        b.requests += 1;
        if (Array.isArray(b.usageRecords)) {
          b.usageRecords.push({
            input: inp,
            cacheRead: cr,
            cacheWrite: cw,
            output: out,
            hour: localHour(ev.time),
          });
        }
        const hc = b.hourly[localHour(ev.time)];
        hc.input += inp;
        hc.cacheRead += cr;
        hc.cacheWrite += cw;
        hc.output += out;
        hc.requests += 1;
        dayObj.set(key, b);
      }
    }
  }

  sessionRecords.set(sessionId, {
    path: file,
    fileSize: metadata.size,
    fileMtimeMs: metadata.mtimeMs,
    seq: maxSeq,
    provider,
    model,
    days: sessionDays,
  });
  cursors.set(sessionId, {
    seq: maxSeq,
    provider,
    model,
    fileSize: metadata.size,
    fileMtimeMs: metadata.mtimeMs,
    path: file,
  });
  return true;
}

function recomputeCosts(pricing) {
  for (const [date, dayObj] of days) {
    const weekday = weekdayFromDayKey(date);
    for (const b of dayObj.values()) b.estimatedCostUsd = costUsd(b, pricing, weekday);
  }
}

// Collapse the model buckets into provider buckets after model-specific
// pricing has been applied. The optional hourly series is used by today's
// chart; historical summaries only need daily totals.
function summarizeProviders(dayObj, pricing, weekday, includeHourly = false) {
  if (!dayObj) return [];
  const providers = new Map();
  for (const b of dayObj.values()) {
    const providerText = b.provider == null ? "" : String(b.provider).trim();
    const provider = providerText || UNKNOWN;
    let summary = providers.get(provider);
    if (!summary) {
      summary = {
        provider,
        usd: 0,
        requests: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      if (includeHourly) {
        summary.hourly = Array.from({ length: 24 }, (_, hour) => ({
          hour,
          usd: 0,
          requests: 0,
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
        }));
      }
      providers.set(provider, summary);
    }

    summary.usd += b.estimatedCostUsd || 0;
    summary.requests += b.requests || 0;
    summary.input += b.input || 0;
    summary.output += b.output || 0;
    summary.cacheRead += b.cacheRead || 0;
    summary.cacheWrite += b.cacheWrite || 0;

    if (includeHourly) {
      const hourCosts = bucketHourlyCostsUsd(b, pricing, weekday);
      for (let hour = 0; hour < 24; hour++) {
        const source = b.hourly?.[hour];
        const target = summary.hourly[hour];
        if (!target) continue;
        target.usd += hourCosts[hour];
        if (!source) continue;
        target.requests += source.requests || 0;
        target.input += source.input || 0;
        target.cacheRead += source.cacheRead || 0;
        target.cacheWrite += source.cacheWrite || 0;
        target.output += source.output || 0;
      }
    }
  }

  return [...providers.values()]
    .sort((a, b) => a.provider.localeCompare(b.provider))
    .map((summary) => {
      summary.usd = +summary.usd.toFixed(4);
      if (summary.hourly) {
        summary.hourly = summary.hourly.map((hour) => ({
          ...hour,
          usd: +hour.usd.toFixed(4),
        }));
      }
      return summary;
    });
}

function emit(pricing) {
  const today = dayKey(Date.now());
  const weekday = weekdayFromDayKey(today);
  const dayObj = days.get(today);
  let usd = 0, requests = 0, input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
  if (dayObj) {
    for (const b of dayObj.values()) {
      usd += b.estimatedCostUsd;
      requests += b.requests;
      input += b.input;
      output += b.output;
      cacheRead += b.cacheRead;
      cacheWrite += b.cacheWrite;
    }
  }
  // Keep enough daily rows for the panel's rolling 12-calendar-month view.
  // 370 covers leap years and month-boundary gaps while keeping the payload small.
  const dayList = [...days.keys()].sort().reverse().slice(0, 370); // newest first
  const recent = dayList.map((d) => {
    let u = 0, r = 0, inp = 0, out = 0, cr = 0, cw = 0;
    const m = days.get(d);
    if (m) for (const b of m.values()) {
      u += b.estimatedCostUsd;
      r += b.requests;
      inp += b.input;
      out += b.output;
      cr += b.cacheRead;
      cw += b.cacheWrite;
    }
    return {
      date: d,
      usd: +u.toFixed(4),
      requests: r,
      input: inp,
      output: out,
      cacheRead: cr,
      cacheWrite: cw,
      providers: summarizeProviders(m, pricing, weekdayFromDayKey(d)),
    };
  });
  // Per-hour series for today (0–24), feeding the panel's 天 (day) view. Cost
  // per bucket is a single pass over its records; only token stats are summed
  // per hour afterwards.
  const bucketCosts = [];
  if (dayObj) {
    for (const b of dayObj.values()) bucketCosts.push({ bucket: b, costs: bucketHourlyCostsUsd(b, pricing, weekday) });
  }
  const hourly = Array.from({ length: 24 }, (_, h) => {
    let u = 0, r = 0, inp = 0, out = 0, cr = 0, cw = 0;
    for (const { bucket: b, costs } of bucketCosts) {
      u += costs[h];
      const hb = b.hourly?.[h];
      if (!hb) continue;
      inp += hb.input;
      cr += hb.cacheRead;
      cw += hb.cacheWrite;
      out += hb.output;
      r += hb.requests || 0;
    }
    return { hour: h, usd: +u.toFixed(4), requests: r, input: inp, cacheRead: cr, cacheWrite: cw, output: out };
  });
  const providers = summarizeProviders(dayObj, pricing, weekday, true);
  // The badge is always shown in CNY: totals already in CNY need no rate; USD
  // totals are converted with the live exchange rate.
  const cny = totalCurrencyOf(pricing) === "cny" ? usd : usd * (pricing.exchangeRate || 1);
  console.log(
    JSON.stringify({
      today: {
        date: today,
        cny: +cny.toFixed(2),
        usd: +usd.toFixed(4),
        requests,
        input,
        output,
        cacheRead,
        cacheWrite,
        hourly,
        providers,
      },
      recent,
      exchangeRate: pricing.exchangeRate,
      totalCurrency: totalCurrencyOf(pricing),
    }),
  );
}

let timer = null;
let currentMs = POLL_MS;
let paused = false;
let cacheLoaded = false;
let cacheDirty = false;
let cacheSaveTimer = null;

function scheduleCacheSave() {
  cacheDirty = true;
  if (cacheSaveTimer) return;
  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null;
    if (cacheDirty) {
      cacheDirty = false;
      saveUsageCache();
    }
  }, 1000);
}

function flushUsageCache() {
  if (cacheSaveTimer) {
    clearTimeout(cacheSaveTimer);
    cacheSaveTimer = null;
  }
  if (cacheDirty) {
    cacheDirty = false;
    saveUsageCache();
  }
}

function refresh() {
  const pricing = loadPricing();
  let emittedCachedSnapshot = false;
  if (!cacheLoaded) {
    loadUsageCache();
    cacheLoaded = true;
    // Emit the persisted snapshot before touching the log contents. This makes
    // the badge and historical charts available immediately on later starts.
    recomputeCosts(pricing);
    if (sessionRecords.size > 0) {
      emit(pricing);
      emittedCachedSnapshot = true;
    }
  }
  let changed = false;
  for (const f of logFiles(sessionsRoot())) changed = foldSession(f) || changed;
  if (changed) {
    mergeSessionDays();
    scheduleCacheSave();
  }
  recomputeCosts(pricing);
  // A cache hit with no changed files was already emitted above. Avoid sending
  // the same payload twice; changed files still trigger the corrected snapshot.
  if (!emittedCachedSnapshot || changed) emit(pricing);
  // Dynamic poll interval: a `pollMs` in the pricing config overrides the env
  // default (and takes effect on the next refresh without a restart).
  const ms = Number(pricing.pollMs) || POLL_MS;
  if (ms !== currentMs) {
    currentMs = ms;
    startTimer();
  }
}

// At most one timer exists at any time: startTimer always clears the previous
// interval first, so re-creating it (pollMs change, resume, startup) can never
// leak a second timer that `pause` would then be unable to stop.
function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function startTimer() {
  stopTimer();
  if (!paused) timer = setInterval(refresh, currentMs);
}

// Refresh is best-effort: a throw must never kill the polling loop, or a
// pause/resume cycle could leave the sidecar silent until restart.
function refreshSafe() {
  try {
    refresh();
  } catch (err) {
    process.stderr.write("usage sidecar: refresh failed: " + ((err && err.stack) || err) + "\n");
  }
}

// The desktop shell pauses this loop while the usage dialog is open so the
// dialog remains a snapshot of the data captured at open time. The sidecar
// resumes on close and immediately emits a fresh aggregate.
const control = createInterface({ input: process.stdin });
control.on("line", (line) => {
  const command = line.trim().toLowerCase();
  if (command === "pause") {
    paused = true;
    stopTimer();
  } else if (command === "resume") {
    if (!paused) return;
    paused = false;
    refreshSafe();
    startTimer();
  }
});
control.on("close", () => {
  flushUsageCache();
  process.exit(0);
});

refreshSafe();
startTimer();
process.on("SIGINT", () => {
  stopTimer();
  flushUsageCache();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopTimer();
  flushUsageCache();
  process.exit(0);
});
