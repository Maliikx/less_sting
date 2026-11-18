import test from "node:test"
import assert from "node:assert/strict"
import { cleanText, findViolations, needsTranslation } from "../lib/cleaning/clean"

test("title: banned clauses are cut, the rest stays", () => {
  const r = cleanText("🔥Fortnite Account | Instant Delivery | 200 skins | Warranty", "title")
  assert.equal(r.text, "🔥Fortnite Account | 200 skins")
  assert.equal(findViolations(r.text).length, 0)
})

test("title: when the whole title is one clause, only the banned words are cut", () => {
  assert.equal(cleanText("Account with warranty", "title").text, "Account")
  assert.equal(cleanText("Instant ✅ Auto-delivery Full access Rank Diamond", "title").text, "✅ Full access Rank Diamond")
})

test("synonyms and spellings: autodelivery, auto-delivery, guaranteed, warranties", () => {
  for (const s of ["autodelivery", "Auto-Delivery", "auto delivered", "guaranteed", "Warranties", "REFUND", "money back", "personal account"]) {
    assert.ok(findViolations(s).length > 0, s)
  }
})

test("Russian terms and endings", () => {
  const r = cleanText("Аккаунт Fortnite | Мгновенная выдача | Гарантия | 150 скинов", "title")
  assert.equal(r.text, "Аккаунт Fortnite | 150 скинов")
  for (const s of ["автовыдача", "Гарантии", "личный аккаунт", "возврат средств", "фанпей"]) assert.ok(findViolations(s).length > 0, s)
})

test("marketplace names and links are caught, normal words are not", () => {
  assert.ok(findViolations("buy on funpay.com").length > 0)
  assert.ok(findViolations("also on G2G and Eldorado").length > 0)
  assert.equal(findViolations("Account has 200 skins, level 150, email can be changed").length, 0)
  assert.equal(findViolations("Instance of the game, installation guide").length, 0) // 'instant' must not match 'instance'
})

test("description: ad/contact sentences are dropped, facts stay", () => {
  const r = cleanText(
    "Full access, instant delivery, 200 skins.\nWrite me in Telegram @seller123 for discounts!\nI give a 100% guarantee. Check my reviews on FunPay.\nEmail can be changed.",
    "description"
  )
  assert.equal(r.text, "Full access, 200 skins.\n\nEmail can be changed.")
  assert.ok(r.removed.some(x => x.reason === "handle" || x.reason === "messenger"))
  assert.equal(findViolations(r.text).length, 0)
})

test("phones, emails and handles", () => {
  for (const s of ["call +20 100 123 4567", "mail me a@b.com", "ping @someone", "01001234567"]) {
    assert.ok(findViolations(s).length > 0, s)
  }
  assert.equal(findViolations("Level 100, 2000 V-Bucks").length, 0)
})

test("language detection by script, no model", () => {
  assert.equal(needsTranslation("Аккаунт Fortnite 150 уровень"), true)
  assert.equal(needsTranslation("Fortnite account level 150"), false)
  assert.equal(needsTranslation(""), false)
})

test("custom extra terms from BLOCKLIST_EXTRA", async () => {
  const { compileTerms } = await import("../lib/cleaning/blocklist")
  const terms = compileTerms("cheapest-ever|скидк*")
  assert.ok(findViolations("cheapest ever account", terms).length > 0)
  assert.ok(findViolations("Скидки сегодня", terms).length > 0)
})
