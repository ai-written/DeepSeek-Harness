// Standalone end-to-end check for the context-tier multiplier pricing feature.
// Creates a throwaway DSH_HOME with a small session log, launches the real
// usage sidecar, and asserts the emitted estimates:
//   - requests strictly above the threshold are surcharged with the multiplier
//   - requests at or below the threshold are charged at ×1
//   - editing usage-pricing.json re-prices without a restart
//   - the v2 usage cache keeps per-request usageRecords
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dsh-usage-tier-"));
const sessionsDir = join(root, "sessions", "s1");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(root, "storages"), { recursive: true });

const now = Date.now();
const logPath = join(sessionsDir, "session.jsonl");
const lines = [
  { seq: 1, time: now - 90000, type: "request/context", data: { provider: "testp", model: "m1" } },
  // ctx = input + cacheRead + cacheWrite
  { seq: 2, time: now - 60000, type: "assistant/message", data: { usage: { inputTokens: 4000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } } },
  { seq: 3, time: now - 50000, type: "assistant/message", data: { usage: { inputTokens: 5000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } } },
  { seq: 4, time: now - 40000, type: "assistant/message", data: { usage: { inputTokens: 5001, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } } },
  { seq: 5, time: now - 30000, type: "assistant/message", data: { usage: { inputTokens: 100, cacheReadTokens: 5000, cacheWriteTokens: 100, outputTokens: 0 } } },
].map((o) => JSON.stringify(o)).join("\n");
writeFileSync(logPath, lines);

const pricingPath = join(root, "storages", "usage-pricing.json");
const base = {
  exchangeRate: 6.74,
  totalCurrency: "cny",
  default: { inputPerMillion: 1e6, cacheReadPerMillion: 1e6, cacheWritePerMillion: 1e6, outputPerMillion: 0, currency: "cny" },
  multiplier: 1,
  pollMs: 86400000, // effectively no timer-driven re-emits; only pause/resume triggers
  overrides: {
    m1: {
      inputPerMillion: 1e6,
      cacheReadPerMillion: 1e6,
      cacheWritePerMillion: 1e6,
      outputPerMillion: 0,
      currency: "cny",
      multiplier: 1,
      contextMultiplier: { threshold: "0.005M", multiplier: 2 },
    },
  },
};
writeFileSync(pricingPath, JSON.stringify(base, null, 2));

const sidecar = join(import.meta.dirname, "usage-sidecar.mjs");
const child = spawn(process.execPath, [sidecar], {
  env: { ...process.env, DSH_HOME: root },
  stdio: ["pipe", "pipe", "inherit"],
});

const emissions = [];
child.stdout.on("data", (chunk) => {
  for (const raw of chunk.toString().split("\n")) {
    const t = raw.trim();
    if (!t) continue;
    try {
      emissions.push(JSON.parse(t));
    } catch {
      /* interleaved fragments */
    }
  }
});

const waitFor = (predicate, timeoutMs = 15000, fromIndex = 0) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = emissions.slice(fromIndex).find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for sidecar emission"));
      setTimeout(tick, 50);
    };
    tick();
  });

const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
};

const applyRule = (threshold) => {
  const cfg = JSON.parse(JSON.stringify(base));
  cfg.overrides.m1.contextMultiplier = { threshold, multiplier: 2 };
  writeFileSync(pricingPath, JSON.stringify(cfg, null, 2));
  child.stdin.write("pause\n");
  child.stdin.write("resume\n");
};

const TIERED = 29402; // 4000*1 + 5000*1 + 5001*2 + 5200*2
const FLAT = 19201; // 4000 + 5000 + 5001 + 5200

let exitCode = 1;
try {
  // Suffix parsing maps each of these to the same 5000-token threshold, so
  // every phase below must produce identical totals:
  //   "0.005M" (initial config, exercised by the startup emission), "5K",
  //   "0.000005B"
  // Boundary check: the request at exactly 5000 stays flat (strictly greater).

  // 1) startup emission: decimal M suffix + boundary semantics
  const first = await waitFor((p) => p.today && p.today.requests === 4, 15000, 0);
  assert(Math.abs(first.today.usd - TIERED) < 0.01, `tiered(M) total ${first.today.usd} != ${TIERED}`);
  assert(first.today.input === 14101, `input total ${first.today.input} != 14101`);
  assert(first.today.cacheRead === 5000, `cacheRead total ${first.today.cacheRead} != 5000`);
  assert(first.today.cacheWrite === 100, `cacheWrite total ${first.today.cacheWrite} != 100`);
  assert(first.today.cny === first.today.usd, "cny badge should equal internal cny total");

  // 2) remove the rule and force a refresh via pause/resume: prices must drop
  //    to flat without restart.
  const flat = JSON.parse(JSON.stringify(base));
  delete flat.overrides.m1.contextMultiplier;
  writeFileSync(pricingPath, JSON.stringify(flat, null, 2));
  child.stdin.write("pause\n");
  child.stdin.write("resume\n");
  const second = await waitFor((p) => p.today && p.today.requests === 4 && Math.abs(p.today.usd - FLAT) < 0.01);
  assert(Math.abs(second.today.usd - FLAT) < 0.01, `flat total ${second.today.usd} != ${FLAT}`);

  // 3) K suffix re-applies the tier at the same threshold.
  const markK = emissions.length;
  applyRule("5K");
  const third = await waitFor((p) => p.today && p.today.requests === 4 && Math.abs(p.today.usd - TIERED) < 0.01, 15000, markK);
  assert(Math.abs(third.today.usd - TIERED) < 0.01, `tiered(K) total ${third.today.usd} != ${TIERED}`);

  // 4) B suffix re-applies the tier at the same threshold.
  const markB = emissions.length;
  applyRule("0.000005B");
  const fourth = await waitFor((p) => p.today && p.today.requests === 4 && Math.abs(p.today.usd - TIERED) < 0.01, 15000, markB);
  assert(Math.abs(fourth.today.usd - TIERED) < 0.01, `tiered(B) total ${fourth.today.usd} != ${TIERED}`);

  // 5) per-provider and hourly totals must add up to the day total.
  const providerUsd = second.today.providers.reduce((s, p) => s + p.usd, 0);
  assert(Math.abs(providerUsd - second.today.usd) < 0.01, `provider sum ${providerUsd} != ${second.today.usd}`);
  const hourlyUsd = second.today.hourly.reduce((s, h) => s + h.usd, 0);
  assert(Math.abs(hourlyUsd - second.today.usd) < 0.01, `hourly sum ${hourlyUsd} != ${second.today.usd}`);
} finally {
  child.stdin.end(); // readline 'close' -> flushUsageCache() + exit(0)
  await new Promise((resolve) => {
    child.on("exit", resolve);
    setTimeout(resolve, 3000);
  });
}

// 4) cache file is v2 and retains per-request usageRecords.
const cache = JSON.parse(readFileSync(join(root, "storages", "usage-cache.json"), "utf8"));
assert(cache.version === 2, "cache version should be 2");
const sessions = Object.values(cache.sessions);
const dayKeys = sessions.flatMap((s) => Object.keys(s.days ?? {}));
const dayObj = dayKeys.length ? cache.sessions[Object.keys(cache.sessions)[0]].days[dayKeys[0]] : null;
const bucket = dayObj && Object.values(dayObj)[0];
assert(Array.isArray(bucket?.usageRecords) && bucket.usageRecords.length === 4, "usageRecords should hold 4 entries");
assert(bucket.usageRecords[0].hour === new Date(now - 60000).getHours(), "record hour should be preserved");

rmSync(root, { recursive: true, force: true });
console.log("CONTEXT-TIER VERIFY PASSED");
process.exit(0);
