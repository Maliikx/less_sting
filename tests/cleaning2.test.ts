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
  for (const f of readdirSync(DIR).filter(f => !f.startsWith("dead") && !f.includes(".ru."))) {
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
