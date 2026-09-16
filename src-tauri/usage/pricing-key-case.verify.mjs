// Standalone end-to-end check for case-insensitive pricing-row matching.
// Creates a throwaway DSH_HOME with one session per case, launches the real
// usage sidecar, and asserts the emitted estimates:
//   - a mixed-case row ("deepSeek-flash") prices the lowercase model id
//   - both sides of "provider|model" match case-insensitively
//   - an exact key still beats a case-insensitive match
//   - rows that differ only by case fall back to file order, deterministically
//   - an unlisted model keeps the default row
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dsh-usage-keycase-"));
mkdirSync(join(root, "storages"), { recursive: true });

const now = Date.now();
// One session per case, so each lands in its own provider bucket.
const cases = [
  { dir: "s1", provider: "hsianglee", model: "deepseek-flash" }, // row "deepSeek-flash"
  { dir: "s2", provider: "Hsianglee", model: "deepseek-FLASH-2" }, // row "hsianglee|deepseek-flash-2"
  { dir: "s3", provider: "p3", model: "mixed" }, // exact row "mixed"
  { dir: "s4", provider: "p4", model: "MIXED" }, // case-only -> first row "MiXeD"
  { dir: "s5", provider: "p5", model: "unlisted-model" }, // default row
];
for (const [i, c] of cases.entries()) {
  const dir = join(root, "sessions", c.dir);
  mkdirSync(dir, { recursive: true });
  const lines = [
    { seq: 1, time: now - 60000 - i, type: "request/context", data: { provider: c.provider, model: c.model } },
    { seq: 2, time: now - 30000 - i, type: "assistant/message", data: { usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } } },
  ]
    .map((o) => JSON.stringify(o))
    .join("\n");
  writeFileSync(join(dir, "session.jsonl"), lines);
}

// Every rate is a whole multiple of the 1e6 denominator, so one request of 1000
// input tokens costs exactly (1000/1e6)*rate = rate/1000 in the total currency.
const rate = (m) => ({ inputPerMillion: m, cacheReadPerMillion: m, cacheWritePerMillion: m, outputPerMillion: m, currency: "cny" });
const pricing = {
  exchangeRate: 6.74,
  totalCurrency: "cny",
  multiplier: 1,
  pollMs: 86400000, // no timer-driven re-emits; the startup emission is enough
  default: rate(1e6),
  overrides: {
    "deepSeek-flash": rate(3e6), // mixed case must price the lowercase model id
    "hsianglee|deepseek-flash-2": rate(4e6), // provider and model both differ in case
    MiXeD: rate(5e6), // case-only duplicate, first in file order...
    mixed: rate(7e6), // ...loses to the exact key when the model is "mixed"
  },
};
writeFileSync(join(root, "storages", "usage-pricing.json"), JSON.stringify(pricing, null, 2));

// Expected day cost per provider bucket (total currency = CNY, multiplier 1).
const expected = new Map([
  ["hsianglee", 3000], // "deepSeek-flash" row, matched ignoring case
  ["Hsianglee", 4000], // "hsianglee|deepseek-flash-2" row, both halves differ in case
  ["p3", 7000], // exact "mixed" beats the case-insensitive "MiXeD"
  ["p4", 5000], // no exact key -> first row whose lowercase key matches
  ["p5", 1000], // unlisted model keeps the default row
]);

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

const waitFor = (predicate, timeoutMs = 15000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = emissions.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for sidecar emission"));
      setTimeout(tick, 50);
    };
    tick();
  });

const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
};

let exitCode = 1;
try {
  const first = await waitFor((p) => p.today && p.today.requests === cases.length);
  const byProvider = new Map(first.today.providers.map((p) => [p.provider, p.usd]));
  for (const [provider, want] of expected) {
    const got = byProvider.get(provider);
    assert(got !== undefined, `provider ${provider} missing from emission`);
    assert(Math.abs(got - want) < 0.01, `provider ${provider} cost ${got} != ${want} (case-insensitive row not applied)`);
  }
  const dayTotal = [...expected.values()].reduce((s, v) => s + v, 0);
  assert(Math.abs(first.today.usd - dayTotal) < 0.01, `day total ${first.today.usd} != ${dayTotal}`);
  const providerSum = first.today.providers.reduce((s, p) => s + p.usd, 0);
  assert(Math.abs(providerSum - first.today.usd) < 0.01, `provider sum ${providerSum} != ${first.today.usd}`);
  exitCode = 0;
} finally {
  child.stdin.end(); // readline 'close' -> flushUsageCache() + exit(0)
  await new Promise((resolve) => {
    child.on("exit", resolve);
    setTimeout(resolve, 3000);
  });
  rmSync(root, { recursive: true, force: true });
}

if (exitCode !== 0) process.exit(exitCode);
console.log("PRICING-KEY-CASE VERIFY PASSED");
process.exit(0);
