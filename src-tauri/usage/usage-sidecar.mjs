// usage-sidecar.mjs — dsh-usage-stats: desktop badge data sidecar.
//
// Self-contained: folds the DSH session logs (~/.dsh/sessions) into per-day /
// per-model token buckets + estimated cost, and prints one JSON line to stdout
// on every recompute (startup + per poll interval) so the Tauri shell can emit
// it to the in-window usage panel. Reads ~/.dsh/storages/usage-pricing.json for
// prices + exchange rate (re-read each emit so edits apply live).
//
// Runs in memory: keeps per-session fold cursors and re-folds only appended
// tails, so each poll is cheap. No checkpoint file written.
//
// Print protocol: one JSON object per line, e.g.
//   {"today":{"date":"2026-08-19","cny":12.34,"usd":1.714,"requests":89,
//             "hourly":[{hour,usd,requests,input,cacheRead,cacheWrite,output}×24],
//             "providers":[{provider,usd,requests,...,hourly:[...]}]},
//    "recent":[{date,usd,requests,"providers":[{provider,usd,requests,...}]}],
//    "exchangeRate":7.2,"totalCurrency":"usd"}
// Every `usd` field holds the amount in the configured total currency
// (totalCurrency: "usd" | "cny"); `cny` is always the CNY badge value.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

/// Cost of one hour's tokens for a bucket: that hour's time-of-use multiplier
/// and the model multiplier applied. Shared by costUsd (bucket total) and the
/// per-hour series emitted to the panel's day view. The result is expressed in
/// the configured total currency (see totalCurrencyOf).
function hourlyCostUsd(bucket, hour, pricing, weekday = flatWeekday()) {
  const p = resolvePrice(pricing, bucket.provider, bucket.model);
  const mm = modelMultiplier(pricing, bucket.provider, bucket.model);
  const m = bucket.hourly?.[hour];
  if (!m) return 0;
  const mult = multiplierFor(weekday, hour, modelTimeOfUse(pricing, bucket.provider, bucket.model));
  const cost =
    ((m.input / 1e6) * p.inputPerMillion +
      (m.cacheRead / 1e6) * p.cacheReadPerMillion +
      (m.cacheWrite / 1e6) * p.cacheWritePerMillion +
      (m.output / 1e6) * p.outputPerMillion) *
    mult *
    mm;
  return convertCost(cost, resolveCurrency(pricing, bucket.provider, bucket.model), pricing);
}

function costUsd(bucket, pricing, weekday = flatWeekday()) {
  // If the bucket carries hourly token splits, price per hour so peak/valley
  // time-of-use multipliers apply; otherwise fall back to flat pricing.
  const h = bucket.hourly;
  if (h && Array.isArray(h) && h.length === 24) {
    let total = 0;
    for (let hour = 0; hour < 24; hour++) total += hourlyCostUsd(bucket, hour, pricing, weekday);
    return total;
  }
  const p = resolvePrice(pricing, bucket.provider, bucket.model);
  const tou = modelTimeOfUse(pricing, bucket.provider, bucket.model);
  const mm = modelMultiplier(pricing, bucket.provider, bucket.model);
  const mult = multiplierFor(flatWeekday(), flatHour(), tou);
  const cost =
    ((bucket.input / 1e6) * p.inputPerMillion +
      (bucket.cacheRead / 1e6) * p.cacheReadPerMillion +
      (bucket.cacheWrite / 1e6) * p.cacheWritePerMillion +
      (bucket.output / 1e6) * p.outputPerMillion) *
    mult *
    mm;
  return convertCost(cost, resolveCurrency(pricing, bucket.provider, bucket.model), pricing);
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

// days: Map<date, Map<"provider|model", bucket>>
const days = new Map();
// cursors: Map<sessionId, { seq, provider, model, fileSize }>
const cursors = new Map();

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
    else if (/^session\.jsonl(\.zstd)?$/.test(e.name)) out.push(p);
  }
  return out;
}

function sessionIdFromLogPath(p) {
  return p.split(/[\\/]/).slice(-2, -1)[0] ?? p;
}

function foldSession(file) {
  const sessionId = sessionIdFromLogPath(file);
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  const cur = cursors.get(sessionId);
  if (cur && cur.fileSize === size) return; // skip-EOF: no new data
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    return;
  }
  const text = /\.zstd$/i.test(file) ? decodeMultiFrame(buf) : buf.toString("utf8");
  const lines = text.split("\n").filter(Boolean);

  const startSeq = cur?.seq ?? -1;
  let provider = cur?.provider ?? null;
  let model = cur?.model ?? null;
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
    if (seq <= startSeq) continue;

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
        let dayObj = days.get(date);
        if (!dayObj) {
          dayObj = new Map();
          days.set(date, dayObj);
        }
        const b =
          dayObj.get(key) ??
          { provider: pm, model: mm, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0, estimatedCostUsd: 0, hourly: initHourly() };
        const inp = u.inputTokens ?? 0;
        const cr = u.cacheReadTokens ?? 0;
        const cw = u.cacheWriteTokens ?? 0;
        const out = u.outputTokens ?? 0;
        b.input += inp;
        b.cacheRead += cr;
        b.cacheWrite += cw;
        b.output += out;
        b.requests += 1;
        const hc = Array.isArray(b.hourly) ? b.hourly[localHour(ev.time)] : null;
        if (hc) {
          hc.input += inp;
          hc.cacheRead += cr;
          hc.cacheWrite += cw;
          hc.output += out;
          hc.requests = (hc.requests || 0) + 1;
        }
        dayObj.set(key, b);
      }
    }
  }

  cursors.set(sessionId, { seq: maxSeq, provider, model, fileSize: size });
}

function recomputeCosts(pricing) {
  for (const [date, dayObj] of days) {
    const weekday = weekdayFromDayKey(date);
    for (const b of dayObj.values()) b.estimatedCostUsd = costUsd(b, pricing, weekday);
  }
}

// Collapse the model buckets into provider buckets after model-specific
// pricing has been applied. The optional hourly series is used by today's
// chart; recent-day summaries only need daily totals.
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

    if (includeHourly && Array.isArray(b.hourly)) {
      for (let hour = 0; hour < 24; hour++) {
        const source = b.hourly[hour];
        const target = summary.hourly[hour];
        if (!source || !target) continue;
        target.usd += hourlyCostUsd(b, hour, pricing, weekday);
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
  const dayList = [...days.keys()].sort().reverse().slice(0, 30); // newest first, up to 30 days
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
  // Per-hour series for today (0–24), feeding the panel's 天 (day) view.
  const hourly = Array.from({ length: 24 }, (_, h) => {
    let u = 0, r = 0, inp = 0, out = 0, cr = 0, cw = 0;
    if (dayObj) {
      for (const b of dayObj.values()) {
        const hb = b.hourly?.[h];
        if (!hb) continue;
        inp += hb.input;
        cr += hb.cacheRead;
        cw += hb.cacheWrite;
        out += hb.output;
        r += hb.requests || 0;
        u += hourlyCostUsd(b, h, pricing, weekday);
      }
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

function refresh() {
  for (const f of logFiles(sessionsRoot())) foldSession(f);
  const pricing = loadPricing();
  recomputeCosts(pricing);
  emit(pricing);
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
control.on("close", () => process.exit(0));

refreshSafe();
startTimer();
process.on("SIGINT", () => {
  stopTimer();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopTimer();
  process.exit(0);
});
