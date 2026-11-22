import test from "node:test"
import assert from "node:assert/strict"
import { AiClient, readLimit, type FetchLike, type ProviderEntry } from "../lib/ai/provider"
import { aiLimitNotices } from "../lib/auto/aiNotices"
import { MemoryStateStore } from "../lib/state/store"

const DAILY_429 =
  '{"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199850, Requested 1400. Please try again in 7m12.5s.","type":"tokens","code":"rate_limit_exceeded"}}'
const MINUTE_429 =
  '{"error":{"message":"Rate limit reached for model `openai/gpt-oss-20b` ... on tokens per minute (TPM): Limit 8000, Used 7900, Requested 900. Please try again in 6.75s.","code":"rate_limit_exceeded"}}'

test("readLimit: daily quota vs per-minute limit, and when it lifts (Groq's wording)", () => {
  assert.deepEqual(readLimit(429, DAILY_429, null), { kind: "daily", waitMs: 432_500 })
  assert.deepEqual(readLimit(429, MINUTE_429, null), { kind: "minute", waitMs: 6_750 })
  assert.deepEqual(readLimit(429, "slow down", "30"), { kind: "minute", waitMs: 30_000 })
  assert.deepEqual(readLimit(429, "Requests per day (RPD) exceeded. Please try again in 2h3m", null), { kind: "daily", waitMs: (2 * 60 + 3) * 60_000 })
  assert.equal(readLimit(503, "overloaded", null).kind, "error")
})

const CHAIN: ProviderEntry[] = [
  { provider: "groq", model: "openai/gpt-oss-120b", baseUrl: "http://g", apiKey: "k" },
  { provider: "groq", model: "openai/gpt-oss-20b", baseUrl: "http://g", apiKey: "k" },
  { provider: "gemini", model: "gemini-2.5-flash", baseUrl: "http://m", apiKey: "k" },
]
const reply = (status: number, body: string): ReturnType<FetchLike> =>
  Promise.resolve({ ok: status < 400, status, headers: { get: () => null }, text: async () => body })
const OK = JSON.stringify({ choices: [{ message: { content: '{"title":"x"}' } }], usage: { total_tokens: 100 } })

test("AI client: a model out of daily tokens is marked 'daily' (shared with other instances); the next one answers", async () => {
  const store = new MemoryStateStore()
  const t = Date.UTC(2026, 10, 22, 10)
  const a = new AiClient(CHAIN, { store, now: () => t, fetch: async (_u, init) => reply(JSON.parse(init.body).model === "openai/gpt-oss-120b" ? 429 : 200, JSON.parse(init.body).model === "openai/gpt-oss-120b" ? DAILY_429 : OK) })
  assert.equal((await a.chatJson("s", "u")).used, "groq:openai/gpt-oss-20b")
  const b = new AiClient(CHAIN, { store, now: () => t + 1000, fetch: async () => reply(200, OK) })
  const usage = await b.sharedUsage()
  assert.equal(usage[0].limit, "daily")
  assert.ok(usage[0].cooldownSeconds > 400 && usage[0].cooldownSeconds <= 433)
  assert.equal(usage[1].limit, undefined)
})

test("AI client: all models out -> every entry is limited; error says 'out of tokens for today'", async () => {
  const t = Date.UTC(2026, 10, 22, 10)
  const c = new AiClient(CHAIN, { now: () => t, fetch: async () => reply(429, DAILY_429) })
  await assert.rejects(c.chatJson("s", "u"), /out of tokens for today/)
  assert.deepEqual(c.usage().map(u => u.limit), ["daily", "daily", "daily"])
  const budget = new AiClient(CHAIN.slice(0, 1), { now: () => t, dailyTokenBudget: 50, fetch: async () => reply(200, OK) })
  await budget.chatJson("s", "u")
  assert.equal(budget.usage()[0].limit, "budget")
})

test("notices: one toast per model that ran out (once), and one when ALL are out", () => {
  const seen = new Set<string>()
  const day = "2026-11-22"
  const one = aiLimitNotices([
    { entry: "groq:openai/gpt-oss-120b", tokensToday: 199_850, cooldownSeconds: 432, limit: "daily" },
    { entry: "groq:openai/gpt-oss-20b", tokensToday: 10, cooldownSeconds: 0 },
  ], seen, day)
  assert.equal(one.length, 1)
  assert.equal(one[0].title, "AI model out: openai/gpt-oss-120b")
  assert.match(one[0].body, /back in about 7 min/)
  one.forEach(n => seen.add(n.key))
  const again = aiLimitNotices([{ entry: "groq:openai/gpt-oss-120b", tokensToday: 1, cooldownSeconds: 400, limit: "daily" }, { entry: "groq:openai/gpt-oss-20b", tokensToday: 1, cooldownSeconds: 0 }], seen, day)
  assert.equal(again.length, 0, "not repeated")

  const all = aiLimitNotices([
    { entry: "groq:openai/gpt-oss-120b", tokensToday: 1, cooldownSeconds: 400, limit: "daily" },
    { entry: "groq:openai/gpt-oss-20b", tokensToday: 1, cooldownSeconds: 7200, limit: "daily" },
    { entry: "gemini:gemini-2.5-flash", tokensToday: 1, cooldownSeconds: 0, limit: "budget" },
  ], seen, day)
  assert.deepEqual(all.map(n => n.title), ["AI model out: openai/gpt-oss-20b", "AI model out: gemini-2.5-flash", "All 3 AI models are out of tokens"])
  assert.equal(all[2].tone, "error")
  assert.match(all[2].body, /marked “check”.*first one in about 7 min/)

  const short = aiLimitNotices([{ entry: "groq:m", tokensToday: 1, cooldownSeconds: 7, limit: "minute" }, { entry: "groq:n", tokensToday: 1, cooldownSeconds: 0 }], new Set(), day)
  assert.equal(short.length, 0, "a few seconds of per-minute limit is not worth a toast")
})
