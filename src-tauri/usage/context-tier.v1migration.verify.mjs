// Standalone check for the v1 -> v2 usage-cache migration.
// Scenario:
//   - a session log was already deleted; only its v1 aggregate remains in the
//     cache ("gone", day = yesterday) -> must survive with flat legacy pricing
//   - a live session log still exists ("live", day = today) and is also present
//     in the v1 cache with stale size/mtime -> must be re-folded into v2 rows,
//     so the context-tier multiplier (threshold 5000, x2) applies exactly
// Pricing: inputPerMillion = 1e6, everything else 0, totalCurrency cny.
// Expected: today = 5001*2 = 10002; yesterday = 6000 (flat, legacy).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
};
const localDateKey = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const initHourly = () => Array.from({ length: 24 }, () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 }));

const root = mkdtempSync(join(tmpdir(), "dsh-usage-migrate-"));
const sessionsRoot = join(root, "sessions");
mkdirSync(join(root, "storages"), { recursive: true });
mkdirSync(join(sessionsRoot, "live"), { recursive: true });

const now = Date.now();
const DAY = 86400000;
const today = localDateKey(now);
const yesterday = localDateKey(now - DAY);

const logPath = join(sessionsRoot, "live", "session.jsonl");
const liveEvents = [
  { seq: 1, time: now - 10000, type: "request/context", data: { provider: "testp", model: "m2" } },
  { seq: 2, time: now - 5000, type: "assistant/message", data: { usage: { inputTokens: 5001, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } } },
].map((o) => JSON.stringify(o)).join("\n");
writeFileSync(logPath, liveEvents);

const bucket = (input) => ({
  provider: "testp",
  model: "m2",
  input,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  requests: 1,
  hourly: initHourly().map((h, i) => (i === new Date(now - 5000).getHours() ? { ...h, input } : h)),
});
const v1Cache = {
  version: 1,
  sessions: {
    gone: {
      path: join(sessionsRoot, "gone", "session.jsonl"),
      fileSize: 0,
      fileMtimeMs: 0,
      seq: 2,
      provider: "testp",
      model: "m2",
      days: { [yesterday]: { "testp|m2": bucket(6000) } },
    },
    live: {
      path: logPath,
      fileSize: 1, // stale on purpose: the file is bigger on disk
      fileMtimeMs: 1,
      seq: 2,
      provider: "testp",
      model: "m2",
      days: { [today]: { "testp|m2": bucket(5001) } },
    },
  },
};
writeFileSync(join(root, "storages", "usage-cache.json"), JSON.stringify(v1Cache));

const pricing = {
  exchangeRate: 6.74,
  totalCurrency: "cny",
  default: { inputPerMillion: 1e6, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: "cny" },
  multiplier: 1,
  pollMs: 86400000,
  overrides: {
    m2: {
      inputPerMillion: 1e6,
      cacheReadPerMillion: 0,
      cacheWritePerMillion: 0,
      outputPerMillion: 0,
      currency: "cny",
      multiplier: 1,
      contextMultiplier: { threshold: 5000, multiplier: 2 },
    },
  },
};
writeFileSync(join(root, "storages", "usage-pricing.json"), JSON.stringify(pricing, null, 2));

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
      /* ignore fragments */
    }
  }
});
const waitFor = (predicate, timeoutMs = 15000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = emissions.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for emission"));
      setTimeout(tick, 50);
    };
    tick();
  });

try {
  // Post-migration emission: today's live request is tiered exactly (5001 * 2).
  const tiered = await waitFor((p) => p.today && p.today.requests === 1 && Math.abs(p.today.usd - 10002) < 0.01);
  assert(Math.abs(tiered.today.usd - 10002) < 0.01, `today ${tiered.today.usd} != 10002`);
  // Yesterday's deleted-log aggregate survives, priced flat (legacy, no tier).
  const goneDay = tiered.recent.find((r) => r.date === yesterday);
  assert(goneDay && Math.abs(goneDay.usd - 6000) < 0.01, `yesterday ${goneDay?.usd} != 6000`);
  assert(tiered.recent.find((r) => r.date === today), "today should be in recent");
} finally {
  child.stdin.end();
  await new Promise((resolve) => {
    child.on("exit", resolve);
    setTimeout(resolve, 3000);
  });
}

const cache = JSON.parse(readFileSync(join(root, "storages", "usage-cache.json"), "utf8"));
assert(cache.version === 2, "cache should be rewritten as v2");
const liveDays = cache.sessions.live?.days ?? {};
const liveBucket = Object.values(liveDays).flatMap((d) => Object.values(d)).find((b) => b?.model === "m2");
assert(Array.isArray(liveBucket?.usageRecords) && liveBucket.usageRecords.length === 1, "live session should be upgraded to per-request records");
const goneBucket = Object.values(cache.sessions.gone?.days ?? {}).flatMap((d) => Object.values(d)).find((b) => b?.model === "m2");
assert(goneBucket && goneBucket.usageRecords == null, "deleted-log aggregate stays legacy (no per-request records)");

rmSync(root, { recursive: true, force: true });
console.log("V1 MIGRATION VERIFY PASSED");
process.exit(0);
