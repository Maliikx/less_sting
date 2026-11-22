import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { cleanText, findViolations } from "../lib/cleaning/clean"
import { fieldsFromParams, paramLabelFor, polarity, prepareOffer } from "../lib/pipeline/prepare"
import { funpay } from "../lib/sources/funpay"
import { AiClient, type FetchLike } from "../lib/ai/provider"
import { SYSTEM_PROMPT } from "../lib/ai/extract"
import type { FieldSpec } from "../lib/gameFields"

const DIR = join(__dirname, "fixtures", "real")
const real = (id: string) => funpay.parse({ status: 200, html: readFileSync(join(DIR, `${id}.html`), "utf8"), finalUrl: new URL(`https://funpay.com/en/lots/offer?id=${id}`) })

/* ------------------------------------------------------------ the reported offer (Genshin, 69446008) */

test("real offer 69446008: seller policy sentences go, account facts stay", () => {
  const o = real("69446008")
  assert.equal(o.sellerName, "purplelovelycake")
  const c = cleanText(o.description!, "description", undefined, { names: [o.sellerName!] })
  assert.doesNotMatch(c.text, /issued automatically|video recording|no return|refund|before purchasing/i)
  assert.match(c.text, /username isn’t linked/)
  assert.match(c.text, /birthday linked/)
  assert.match(c.text, /pick up your account by email/)
  assert.ok(c.removed.some(r => r.reason === "seller policy" && /IMPORTANT/.test(r.text)), "the whole IMPORTANT sentence is removed")
})

test("real offer 69446008: FunPay params fill the fields (no default): email linked -> email_not_linked = No, Any platform", () => {
  const p = real("69446008").params // Platform: Any platform, Email linking: Email linked, Server: Europe, ...
  assert.equal(paramLabelFor("email_not_linked", p), "Email linking")
  // whatever shape GameBoost uses for the field
  assert.deepEqual(fieldsFromParams([{ key: "email_not_linked", type: "boolean", required: true }], p), { email_not_linked: false })
  assert.deepEqual(fieldsFromParams([{ key: "email_not_linked", type: "enum", required: true, options: ["Unknown", "Yes", "No"] }], p), { email_not_linked: "No" })
  assert.deepEqual(fieldsFromParams([{ key: "email_not_linked", type: "string", required: true }], p), { email_not_linked: "No" })
  assert.deepEqual(fieldsFromParams([{ key: "email_linked", type: "boolean", required: true }], p), { email_linked: true })
  assert.deepEqual(fieldsFromParams([{ key: "platform", type: "array", required: true, options: ["Unknown", "PC", "PlayStation", "Mobile"] }], p), { platform: ["PC", "PlayStation", "Mobile"] }, "any platform = all real platforms")
  assert.deepEqual(fieldsFromParams([{ key: "platform", type: "enum", required: true, options: ["Unknown", "PC", "Cross-platform"] }], p), { platform: "Cross-platform" })
  assert.deepEqual(fieldsFromParams([{ key: "platform", type: "enum", required: true, options: ["Unknown", "PC", "Mobile"] }], p), {}, "single choice and no 'any' option: no guess")
  assert.deepEqual(fieldsFromParams([{ key: "platform", type: "string", required: true }], p), { platform: "Any platform" })
  assert.deepEqual(fieldsFromParams([{ key: "server", type: "enum", required: true, options: ["America", "Europe", "Asia"] }], p), { server: "Europe" })
  assert.deepEqual(fieldsFromParams([{ key: "adventure_rank", type: "integer", required: true }, { key: "ar", type: "integer", required: true }], p), { ar: 48 })
})

test("param matching: same subject words only, ambiguous labels are not guessed; polarity", () => {
  assert.equal(paramLabelFor("phone_not_linked", { "Email linking": "x", "Phone linking": "y" }), "Phone linking")
  assert.equal(paramLabelFor("email", { "Email linking": "x", "Email changed": "y" }), undefined, "two candidates -> no guess")
  assert.equal(paramLabelFor("rank", { "Level": "5" }), undefined)
  assert.equal(polarity("Email linked"), 1)
  assert.equal(polarity("Not linked"), -1)
  assert.equal(polarity("Не привязана"), -1)
  assert.equal(polarity("Europe"), 0)
})

/* ------------------------------------------------------------ general cleaning */

test("cleaning: FAQ blocks, Q/A lines, store introductions, the seller's name and buyer instructions are removed", () => {
  const src = [
    "Hello and welcome to my store!",
    "Level 80 account, 12 legendary skins.",
    "Thank you for choosing NightShop, we deliver in minutes.",
    "",
    "FAQ:",
    "How do I log in? Use the email.",
    "Can I change the password? Yes.",
    "",
    "Q: Is it safe? A: yes",
    "Region: Europe. Email can be changed.",
    "Please record a video while logging in, otherwise no returns.",
    "Check my other offers in my shop NightShop.",
  ].join("\n")
  const c = cleanText(src, "description", undefined, { names: ["NightShop"] })
  assert.equal(c.text, "Level 80 account, 12 legendary skins.\n\nRegion: Europe. Email can be changed.")
  const reasons = new Set(c.removed.map(r => r.reason))
  for (const r of ["store introduction", "FAQ", "seller policy"]) assert.ok(reasons.has(r), r)
})

test("cleaning: Russian policy phrases and 'issued automatically' wording", () => {
  const c = cleanText("Аккаунт 50 уровня. Данные выдаются автоматически. Без возврата средств. Запишите видео покупки.", "description")
  assert.equal(c.text, "Аккаунт 50 уровня.")
  assert.ok(findViolations("Account data is issued automatically").length > 0)
  assert.ok(findViolations("no returns accepted").length > 0)
})

test("cleaning: no big losses on the real offers (account facts kept)", () => {
  // 82035328 is almost all shop marketing: checked on its own below
  for (const f of readdirSync(DIR).filter(f => !f.startsWith("dead") && !f.includes(".ru.") && !f.startsWith("82035328"))) {
    const o = real(f.replace(".html", ""))
    const c = cleanText(o.description || "", "description", undefined, { names: o.sellerName ? [o.sellerName] : [] })
    const kept = c.text.length / Math.max(1, (o.description || "").length)
    assert.ok(kept > 0.3, `${f}: only ${Math.round(kept * 100)}% of the description kept`)
  }
  assert.match(cleanText(real("81847225").description!, "description").text, /GLACIER M416/)
})

/* ------------------------------------------------------------ AI */

function fakeAi(reply: unknown, calls: { n: number; prompts: string[] }) {
  const fetch: FetchLike = async (_url, init) => {
    calls.n++
    calls.prompts.push(init.body)
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { total_tokens: 400 } }) }
  }
  return new AiClient([{ provider: "groq", model: "m", baseUrl: "http://x", apiKey: "k" }], { fetch })
}

test("AI also cleans when the seller is still talking about themselves (I/my/we), even with every field found", async () => {
  const calls = { n: 0, prompts: [] as string[] }
  const src = { ...real("81847225"), description: "Level 82 account.\nI will help you log in, my friend.", params: { Level: "82" } }
  const ai = fakeAi({ title: "Blood Raven X-Suit account", description: "Level 82 account.", ad_sentences: ["I will help you log in, my friend."], fields: {} }, calls)
  const specs: FieldSpec[] = [{ key: "level", type: "integer", required: true }]
  const r = await prepareOffer({ link: "https://funpay.com/en/lots/offer?id=81847225", price: "10", seller: "M" }, { readOffer: async () => src, ai, game: { specs } })
  assert.equal(calls.n, 1)
  assert.equal(r.description, "Level 82 account.")
  assert.equal(r.accountData.level, 82)

  const plain = { ...src, description: "Level 82 account. Region: US server." }
  const calls2 = { n: 0, prompts: [] as string[] }
  await prepareOffer({ link: "https://funpay.com/en/lots/offer?id=81847225", price: "10", seller: "M" }, { readOffer: async () => plain, ai: fakeAi({}, calls2), game: { specs } })
  assert.equal(calls2.n, 0, "plain facts (even 'US') need no AI")
})

test("AI prompt asks to drop seller talk and to read negative field names correctly", () => {
  for (const s of ["issued automatically", "record a video", "FAQ", "store introductions", "email_not_linked", "SOURCE PARAMETERS first", "clearly implies"]) {
    assert.ok(SYSTEM_PROMPT.includes(s), s)
  }
})

/* ------------------------------------------------------------ reported Fortnite offer (82035328) */

test("real offer 82035328 (Fortnite): title cut at emoji/brackets; shop marketing gone, account facts kept", async () => {
  const { gameFromCategory } = await import("../lib/sources/funpay")
  const o = real("82035328")
  assert.equal(o.category, "Accounts for Fortnite")
  assert.equal(gameFromCategory(o.category), "Fortnite")
  const t = cleanText(o.title!, "title")
  assert.equal(t.text, "✅DONATE ACCOUNT✅🔥【MAIL+NATIVE】🔥✅$3000+ SPENT✅KRATOS✅LEVIATHAN✅ANDROMEDA✅")
  assert.deepEqual(t.removed.map(r => r.text), ["INSTANT DELIVERY", "WARRANTY"])
  const d = cleanText(o.description!, "description", undefined, { names: [o.sellerName!] })
  assert.equal(d.text, "5. 📧 All accounts come with a linked email.\n\n🎮There are also several fun games included on the accounts!")
  assert.equal(findViolations(`${t.text}\n${d.text}`).length, 0)
})

test("titles: longest banned phrase wins; leftover empty/unmatched brackets and repeated emoji are tidied", async () => {
  const { tidyBrackets } = await import("../lib/cleaning/clean")
  assert.equal(cleanText("Account | instant delivery | 50 skins", "title").text, "Account | 50 skins")
  assert.equal(tidyBrackets("A 【 】 B [x] (y"), "A   B [x] y")
  assert.equal(tidyBrackets("✅✅ A ✅ ✅ B"), "✅ A ✅ B")
})

test("game fields: a list field described as 'x' + 'x.*' becomes ONE list; values are always sent as lists", async () => {
  const { normalizeSpecs } = await import("../lib/gameFields")
  const { shapeAccountData } = await import("../lib/pipeline/prepare")
  const specs = normalizeSpecs([
    { key: "platform", type: "enum", required: true, options: ["PC", "Mobile"] },
    { key: "linkable_platforms", type: "string", required: true },
    { key: "linkable_platforms.*", type: "enum", required: false, options: ["PC", "PlayStation", "Xbox", "Switch"] },
  ])
  assert.deepEqual(specs.map(s => s.key), ["platform", "linkable_platforms"])
  assert.deepEqual(specs[1], { key: "linkable_platforms", type: "array", required: true, options: ["PC", "PlayStation", "Xbox", "Switch"] })
  // the reported offer: FunPay "Platform: (PC) Battle Royale"
  const fields = fieldsFromParams(specs, real("82035328").params)
  assert.deepEqual(fields.linkable_platforms, ["PC"])
  assert.deepEqual(shapeAccountData(specs, { linkable_platforms: "PC", "linkable_platforms.*": "PC", platform: "PC" }), { linkable_platforms: ["PC"], platform: "PC" })
  assert.deepEqual(shapeAccountData(specs, { linkable_platforms: "(PC) Battle Royale" }), { linkable_platforms: ["PC"] })
  assert.deepEqual(shapeAccountData(specs, { linkable_platforms: "Nintendo 64" }), {}, "not an allowed value: left out, not sent")
})

/* ------------------------------------------------------------ Groq retired the llama models (2026-08-16) */

test("AI: new Groq model names load; reasoning models get low effort and room to answer; retired models are explained", async () => {
  const { loadChain, isReasoningModel } = await import("../lib/ai/provider")
  const chain = loadChain({ AI_PROVIDERS: "groq:openai/gpt-oss-120b,groq:openai/gpt-oss-20b", GROQ_API_KEY: "k" })
  assert.deepEqual(chain.map(c => [c.provider, c.model]), [["groq", "openai/gpt-oss-120b"], ["groq", "openai/gpt-oss-20b"]])
  assert.equal(isReasoningModel("openai/gpt-oss-120b"), true)
  assert.equal(isReasoningModel("llama-3.3-70b-versatile"), false)

  const bodies: Record<string, unknown>[] = []
  const ok: FetchLike = async (_u, init) => {
    bodies.push(JSON.parse(init.body))
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: '{"title":"x"}' } }], usage: { total_tokens: 10 } }) }
  }
  await new AiClient(chain, { fetch: ok }).chatJson("s", "u", { maxTokens: 900 })
  assert.equal(bodies[0].reasoning_effort, "low")
  assert.ok((bodies[0].max_tokens as number) >= 2500)

  const retired: FetchLike = async () => ({
    ok: false, status: 404, headers: { get: () => null },
    text: async () => '{"error":{"message":"The model `llama-3.3-70b-versatile` does not exist or you do not have access to it."}}',
  })
  const old = loadChain({ AI_PROVIDERS: "groq:llama-3.3-70b-versatile", GROQ_API_KEY: "k" })
  await assert.rejects(new AiClient(old, { fetch: retired }).chatJson("s", "u"), /not available any more \(retired or renamed\) - update AI_PROVIDERS/)
})

/* ------------------------------------------------------------ live 422: server invalid, is_ranked_ready must be true/false */

test("yes/no field names (is_/has_/can_) are true/false, never 'Unknown'; GameBoost's 422 types are remembered per game", async () => {
  const { normalizeSpecs, lowestValue, applyLearnedTypes } = await import("../lib/gameFields")
  const { rememberLearnedTypes, readCachedSpecs, writeCachedSpecs } = await import("../lib/auto/gameProfileCache")
  const { MemoryStateStore } = await import("../lib/state/store")
  const specs = normalizeSpecs([
    { key: "is_ranked_ready", type: "string", required: true },
    { key: "has_skins", type: "string", required: false },
    { key: "server", type: "string", required: true },
    { key: "is_region", type: "enum", required: true, options: ["EU", "NA"] }, // has options: not touched
  ])
  assert.deepEqual(specs.map(s => [s.key, s.type]), [["is_ranked_ready", "boolean"], ["has_skins", "boolean"], ["server", "string"], ["is_region", "enum"]])
  assert.equal(lowestValue(specs[0]), false, "default false, not 'Unknown'")
  assert.deepEqual(fieldsFromParams(specs, { "Ranked ready": "Yes" }), { is_ranked_ready: true })

  const learned = applyLearnedTypes([{ key: "wins", type: "string", required: true }], { wins: "integer" })
  assert.equal(learned.changed, true)
  assert.equal(learned.specs[0].type, "integer")

  const store = new MemoryStateStore()
  await writeCachedSpecs(store, 42, [{ key: "ranked_ready", type: "string", required: true }])
  assert.equal(await rememberLearnedTypes(store, 42, { ranked_ready: "boolean" }), true)
  assert.equal((await readCachedSpecs(store, 42))![0].type, "boolean", "the next batch for this game sends true/false")
})

test("publish: learned types from POST /api/offers are handed to the game cache", async () => {
  const { gameboostDestination } = await import("../lib/destinations/gameboost")
  const seen: unknown[] = []
  const dest = gameboostDestination(async () => ({ status: 200, json: { failed: [{ title: "t", error: "x" }], learnedTypes: { is_ranked_ready: "boolean" } } }), {
    onLearnedTypes: async (game, types) => void seen.push([game.id, types]),
  })
  await dest.publish([{ ref: "r", link: "https://funpay.com/en/lots/offer?id=123", seller: "M", title: "t", description: "d", images: ["https://x/y.jpg"], priceInput: "10", accountData: {}, defaulted: [], game: { id: 5, slug: "lol", name: "LoL" } }], { listNow: false, deliveryDuration: 1, deliveryUnit: "hours" })
  assert.deepEqual(seen, [[5, { is_ranked_ready: "boolean" }]])
})
