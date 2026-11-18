import test from "node:test"
import assert from "node:assert/strict"
import { funpay } from "../lib/sources/funpay"
import { canonicalIdOf } from "../lib/sources/index"
import { AiClient, loadChain, type FetchLike } from "../lib/ai/provider"
import { validateFields } from "../lib/ai/extract"
import { applyDefaults, lowestValue, minFromMessage, type FieldSpec } from "../lib/gameFields"
import { fieldsFromParams, prepareOffer, type PrepareDeps } from "../lib/pipeline/prepare"
import { BLOCKED_PAGE, DEAD_OFFER, EN_OFFER, RU_OFFER } from "./fixtures"

const page = (html: string, status = 200, id = "71122224") => ({ status, html, finalUrl: new URL(`https://funpay.com/en/lots/offer?id=${id}`) })
const readOffer = (html: string, status = 200): PrepareDeps["readOffer"] => async () => funpay.parse(page(html, status))

const SPECS: FieldSpec[] = [
  { key: "platform", type: "enum", required: true, options: ["PC", "PlayStation", "Xbox"] },
  { key: "account_level", type: "integer", required: true },
  { key: "skins_count", type: "integer", required: false },
]

/** Fake chat API. `reply` is what the "model" answers. */
function fakeAi(reply: unknown, calls: { n: number } = { n: 0 }) {
  const fetch: FetchLike = async () => {
    calls.n++
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { total_tokens: 500 } }),
    }
  }
  return new AiClient([{ provider: "groq", model: "m", baseUrl: "http://x", apiKey: "k" }], { fetch })
}

test("canonical ids: any language path, repeated links give the same id", () => {
  assert.equal(canonicalIdOf("https://funpay.com/en/lots/offer?id=71122224"), "funpay:71122224")
  assert.equal(canonicalIdOf("https://funpay.com/lots/offer?id=71122224"), "funpay:71122224")
  assert.equal(canonicalIdOf("https://funpay.com/ru/lots/offer?id=71122224&x=1"), "funpay:71122224")
  assert.equal(canonicalIdOf("https://funpay.com/en/lots/123/"), null)
  assert.equal(canonicalIdOf("not a link"), null)
})

test("FunPay parser: title, description, params, images, price", () => {
  const o = funpay.parse(page(EN_OFFER))
  assert.equal(o.status, "ok")
  assert.match(o.title!, /Fortnite Account/)
  assert.match(o.description!, /Full access/)
  assert.equal(o.params["Platform"], "PC")
  assert.equal(o.params["Account level"], "150")
  assert.ok(o.images.length >= 1)
  assert.equal(o.price, 12.5)
  assert.equal(o.currency, "USD")
})

test("FunPay parser: dead, blocked and error are different states", () => {
  assert.equal(funpay.parse(page(DEAD_OFFER)).status, "not_found")
  assert.equal(funpay.parse(page("", 404)).status, "not_found")
  assert.equal(funpay.parse(page(BLOCKED_PAGE, 403)).status, "blocked")
  assert.equal(funpay.parse(page("", 429)).status, "blocked")
  assert.equal(funpay.parse(page("oops", 500)).status, "error")
})

test("defaults: lowest value, listed in `defaulted`", () => {
  assert.equal(lowestValue({ key: "a", type: "integer", required: true }), 0)
  assert.equal(lowestValue({ key: "a", type: "integer", required: true, min: 1 }), 1)
  assert.equal(lowestValue({ key: "a", type: "boolean", required: true }), false)
  assert.equal(lowestValue({ key: "a", type: "enum", required: true, options: ["Bronze", "Gold"] }), "Bronze")
  assert.equal(minFromMessage("The level must be at least 1."), 1)
  const r = applyDefaults(SPECS, { platform: "PC" })
  assert.deepEqual(r.defaulted.map(d => d.key), ["account_level"])
  assert.equal(r.values.account_level, 0)
  assert.equal("skins_count" in r.values, false) // optional fields are never invented
})

test("params fill fields without any AI", () => {
  assert.deepEqual(fieldsFromParams(SPECS, { Platform: "PC", "Account level": "150" }), { platform: "PC", account_level: 150 })
})

test("AI guard: evidence must exist in the source, options and numbers are checked", () => {
  const src = "Rank: Gold. Level 45. Server EU"
  const specs: FieldSpec[] = [
    { key: "rank", type: "enum", required: true, options: ["Bronze", "Gold"] },
    { key: "level", type: "integer", required: true },
    { key: "region", type: "enum", required: false, options: ["EU", "NA"] },
  ]
  const r = validateFields(
    {
      rank: { value: "gold", evidence: "Rank: Gold" },
      level: { value: 99, evidence: "Level 45" }, // number not in evidence -> rejected
      region: { value: "EU", evidence: "made up quote" }, // evidence not in source -> rejected
    },
    specs,
    src
  )
  assert.deepEqual(r.fields, { rank: "Gold" })
  assert.equal(r.rejected.length, 2)
})

test("pipeline: English offer, rules + params, no AI call needed", async () => {
  const calls = { n: 0 }
  const specs = SPECS.filter(s => s.key !== "skins_count")
  const r = await prepareOffer({ link: "https://funpay.com/en/lots/offer?id=71122224", price: "x2", seller: "M" }, {
    readOffer: readOffer(EN_OFFER),
    ai: fakeAi({}, calls),
    game: { specs },
  })
  assert.equal(calls.n, 0, "AI must not be called when rules and params settle everything")
  assert.equal(r.status, "ready")
  assert.equal(r.title, "🔥 Fortnite Account | 200 skins")
  assert.doesNotMatch(r.description, /guarantee|Telegram|reviews|FunPay/i)
  assert.match(r.description, /Email can be changed/)
  assert.deepEqual(r.accountData, { platform: "PC", account_level: 150 })
  assert.equal(r.priceEur, 25) // 12.5 x2, price used as-is
  assert.equal(r.defaulted.length, 0)
})

test("pipeline: Russian offer is translated by the AI, fields need evidence", async () => {
  const calls = { n: 0 }
  const ai = fakeAi(
    {
      title: "Fortnite account, 150 skins",
      description: "Level 150, PC platform.",
      ad_sentences: ["Write me on Telegram."],
      fields: { account_level: { value: 150, evidence: "Уровень 150" }, platform: { value: "PC", evidence: "платформа PC" } },
    },
    calls
  )
  const r = await prepareOffer({ link: "https://funpay.com/en/lots/offer?id=71122224", price: "20", seller: "M" }, {
    readOffer: readOffer(RU_OFFER),
    ai,
    game: { specs: SPECS.filter(s => s.key !== "skins_count") },
  })
  assert.equal(calls.n, 1)
  assert.equal(r.language, "translated")
  assert.equal(r.title, "Fortnite account, 150 skins")
  assert.equal(r.accountData.account_level, 150)
  assert.equal(r.status, "ready")
  assert.equal(r.priceEur, 20)
})

test("pipeline: required field not found -> lowest value + warning, still listed", async () => {
  const ai = fakeAi({ title: "Fortnite account", description: "Skins.", ad_sentences: [], fields: {} })
  const r = await prepareOffer({ link: "https://funpay.com/en/lots/offer?id=71122224", price: "20", seller: "M" }, {
    readOffer: readOffer(RU_OFFER.replace("Платформа", "Прочее")),
    ai,
    game: { specs: [{ key: "rank", type: "enum", required: true, options: ["Bronze", "Gold"] }] },
  })
  assert.deepEqual(r.defaulted.map(d => [d.key, d.value]), [["rank", "Bronze"]])
  assert.ok(r.flags.some(f => f.code === "defaulted" && f.level === "warn"))
  assert.equal(r.status, "ready") // user decision: list immediately, but highlighted
})

test("pipeline: Russian text with no AI available is NOT published as-is", async () => {
  const r = await prepareOffer({ link: "https://funpay.com/en/lots/offer?id=71122224", price: "20", seller: "M" }, {
    readOffer: readOffer(RU_OFFER),
    ai: new AiClient([]),
    game: null,
  })
  assert.equal(r.status, "needs_review")
  assert.ok(r.flags.some(f => f.code === "untranslated"))
})

test("pipeline: AI that re-introduces a banned word is caught by the final gate", async () => {
  const ai = fakeAi({ title: "Fortnite account with warranty", description: "Contact me on discord.", ad_sentences: [], fields: {} })
  const r = await prepareOffer({ link: "https://funpay.com/en/lots/offer?id=71122224", price: "20", seller: "M" }, {
    readOffer: readOffer(RU_OFFER),
    ai,
    game: null,
  })
  assert.doesNotMatch(r.title, /warranty/i)
  assert.doesNotMatch(r.description, /discord/i)
})

test("pipeline: duplicate is stopped before the page is even fetched", async () => {
  let fetched = 0
  const r = await prepareOffer({ link: "https://funpay.com/en/lots/offer?id=71122224", price: "20", seller: "M" }, {
    readOffer: async () => { fetched++; return funpay.parse(page(EN_OFFER)) },
    ai: null,
    game: null,
    isDuplicate: () => "sheet row 5: Fortnite Account",
  })
  assert.equal(r.status, "duplicate")
  assert.equal(fetched, 0)
})

test("pipeline: dead and blocked offers cost no AI and are reported differently", async () => {
  const calls = { n: 0 }
  const ai = fakeAi({}, calls)
  const dead = await prepareOffer({ link: "https://funpay.com/en/lots/offer?id=1234567", price: "20", seller: "M" }, { readOffer: readOffer(DEAD_OFFER), ai, game: null })
  const blocked = await prepareOffer({ link: "https://funpay.com/en/lots/offer?id=1234567", price: "20", seller: "M" }, { readOffer: readOffer(BLOCKED_PAGE, 403), ai, game: null })
  assert.equal(dead.status, "dead")
  assert.equal(blocked.status, "blocked")
  assert.equal(calls.n, 0)
})

test("pipeline: multiplier without a readable source price is an error, not a guess", async () => {
  const r = await prepareOffer({ link: "https://funpay.com/en/lots/offer?id=71122224", price: "x2", seller: "M" }, {
    readOffer: readOffer(EN_OFFER.replace(/<div class="payment-value">[\s\S]*?<\/div>\s*<div class="tc-price"[\s\S]*?<\/div>/, "")),
    ai: null,
    game: null,
  })
  assert.equal(r.status, "needs_review")
  assert.ok(r.flags.some(f => f.code === "price"))
})

test("AI chain: 429 falls through to the next provider and starts a cooldown", async () => {
  let t = 1_000_000
  const seen: string[] = []
  const fetch: FetchLike = async (url, init) => {
    const model = JSON.parse(init.body).model
    seen.push(model)
    if (model === "big") return { ok: false, status: 429, headers: { get: () => "30" }, text: async () => "slow down" }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { total_tokens: 10 } }) }
  }
  const ai = new AiClient(
    [
      { provider: "groq", model: "big", baseUrl: "http://x", apiKey: "k" },
      { provider: "groq", model: "small", baseUrl: "http://x", apiKey: "k" },
    ],
    { fetch, now: () => t }
  )
  const a = await ai.chatJson("s", "u")
  assert.equal(a.used, "groq:small")
  await ai.chatJson("s", "u")
  assert.deepEqual(seen, ["big", "small", "small"], "big must not be retried during its cooldown")
  t += 31_000
  await ai.chatJson("s", "u")
  assert.equal(seen.at(-2), "big", "big is tried again after the cooldown")
})

test("AI chain config: needs a key, skips unknown providers", () => {
  const chain = loadChain({ AI_PROVIDERS: "groq:llama-3.3-70b-versatile,gemini:g,ollama:qwen2.5:7b,bogus:x", GROQ_API_KEY: "k" })
  assert.deepEqual(chain.map(c => `${c.provider}:${c.model}`), ["groq:llama-3.3-70b-versatile", "ollama:qwen2.5:7b"])
})
