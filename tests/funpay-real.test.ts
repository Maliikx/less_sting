import test from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { funpay, gameFromCategory, pickPrice } from "../lib/sources/funpay"
import type { SourceOffer } from "../lib/sources/types"
import { EN_OFFER } from "./fixtures"

/** Real FunPay pages saved by the probe on 2026-11-18 (guest CSRF tokens redacted). File name = lot id. */
const DIR = join(__dirname, "fixtures", "real")
const files = readdirSync(DIR).filter(f => f.endsWith(".html"))
const parse = (f: string, status = 200): SourceOffer => {
  const id = (f.match(/(\d{3,})/) || [])[1]
  return funpay.parse({ status, html: readFileSync(join(DIR, f), "utf8"), finalUrl: new URL(`https://funpay.com/en/lots/offer?id=${id}`) })
}
const live = files.filter(f => !f.startsWith("dead-")).map(f => ({ f, o: parse(f) }))
const FORM_LABELS = /charged for|remaining price|payment discount|in\s*stock|seller's rating|наличие/i

test("real pages: every live page is ok with title, description, price and category", () => {
  assert.ok(live.length >= 15)
  for (const { f, o } of live) {
    assert.equal(o.status, "ok", f)
    assert.ok(o.title && o.title.length > 3, `${f}: title`)
    assert.ok(o.description && o.description.length > 50, `${f}: description`)
    assert.ok(o.price && o.price > 0, `${f}: price`)
    assert.ok(o.category, `${f}: category`)
    assert.ok(o.categoryId && /^\d+$/.test(o.categoryId), `${f}: category id`)
  }
})

test("real pages: purchase-form labels are never offer parameters", () => {
  for (const { f, o } of live) for (const k of Object.keys(o.params)) assert.doesNotMatch(k, FORM_LABELS, `${f}: ${k}`)
  const pubg = parse("81847225.html")
  assert.deepEqual(pubg.params, {
    "Offer type": "Sale", Level: "82", Rank: "Platinum", "Mythic skins": "10+", "Leveled weapons": "10+", "Kill chats": "No", "Sport cars": "1-5",
  })
})

test("real pages: images are the full-size gallery links, never thumbnails or site images", () => {
  const o = parse("81847225.html")
  assert.equal(o.images.length, 5)
  assert.equal(o.images[0], "https://sfunpay.com/s/offer/9f/ry/9fryp1oxw2cs5n0dnvtd.jpg") // href, not the background-image thumb
  assert.ok(!o.images.includes("https://sfunpay.com/s/offer/o1/4b/o14b2awaruomsmaplv9y.jpg"))
  for (const { f, o } of live) for (const u of o.images) assert.match(u, /^https:\/\/sfunpay\.com\/s\/offer\//, `${f}: ${u}`)
})

test("real pages: no gallery -> no images, a warning, and the external album/video links for the employee", () => {
  const postimg = parse("60939088.html")
  assert.equal(postimg.images.length, 0)
  assert.deepEqual(postimg.externalMedia, ["https://postimg.cc/gallery/dFBtvf7"])
  assert.ok(postimg.warnings.some(w => /no images on FunPay/.test(w)))
  assert.deepEqual(parse("62421214.html").externalMedia, ["https://imgur.com/a/duUZpL4"])
  const nothing = parse("81849764.html")
  assert.equal(nothing.images.length, 0)
  assert.deepEqual(nothing.externalMedia, [])
})

test("real pages: price is one currency, without 'from', with the seller's own price alongside", () => {
  const o = parse("81847225.html")
  assert.equal(o.price, 180.64)
  assert.equal(o.priceText, "180.64 $")
  assert.equal(o.currency, "USD")
  assert.equal(o.sellerPrice, 167.99)
  for (const { f, o } of live) assert.doesNotMatch(o.priceText || "", /from/i, f)
})

test("real pages: a page offering USD, EUR and RUB is read in USD, the same in both languages", () => {
  const en = parse("82449081.html")
  const ru = parse("82449081.ru.html")
  assert.deepEqual([...new Set(en.priceOptions!.map(p => p.currency))].sort(), ["EUR", "RUB", "USD"])
  assert.equal(en.price, 83.84) // the old reader took the smallest number of any currency: 75.49 €
  assert.equal(en.currency, "USD")
  assert.equal(ru.price, en.price)
  assert.equal(ru.currency, "USD")
  assert.equal(en.priceOptions!.find(p => p.currency === "RUB")!.sellerPrice, 6600)
})

test("real pages: /en/ shows FunPay's English translation of a Russian offer; /ru/ layout parses too", () => {
  const en = parse("82449081.html")
  const ru = parse("82449081.ru.html")
  assert.match(en.title!, /^💎Top account/)
  assert.doesNotMatch(en.title!, /[а-яё]/i)
  assert.match(ru.title!, /Топовый аккаунт/)
  assert.equal(en.game, "PUBG Mobile")
  assert.equal(ru.game, "PUBG Mobile")
  assert.equal(ru.params["Уровень"], "48")
  assert.equal(en.images.length, 6)
  assert.deepEqual(ru.images, en.images)
})

test("real pages: game from the category name", () => {
  assert.equal(parse("81843891.html").game, "Raid: Shadow Legends")
  assert.equal(parse("79376712.html").game, "Tom Clancy's Rainbow Six")
  assert.equal(parse("79376712.html").params["Game"], "(PC) Siege")
  assert.equal(gameFromCategory("Аккаунты Apex Legends"), "Apex Legends")
  assert.equal(gameFromCategory("Steam Gift Cards"), undefined, "not an accounts category: no guess")
})

test("real dead page is not_found; blocked and unknown layouts are never dead", () => {
  assert.equal(parse("dead-71122224.html", 404).status, "not_found")
  assert.equal(parse("dead-71122224.html", 200).status, "not_found", "the heading alone is enough")
  assert.equal(funpay.parse({ status: 403, html: "<html>Just a moment...</html>", finalUrl: new URL("https://funpay.com/en/lots/offer?id=123") }).status, "blocked")
  const odd = funpay.parse({ status: 200, html: "<html><h1>Maintenance</h1></html>", finalUrl: new URL("https://funpay.com/en/lots/offer?id=123") })
  assert.equal(odd.status, "error")
})

test("a live offer whose description says 'offer not found' is NOT dead", () => {
  const html = EN_OFFER.replace("Email can be changed.", "If you see offer not found, message me.")
  const o = funpay.parse({ status: 200, html, finalUrl: new URL("https://funpay.com/en/lots/offer?id=123") })
  assert.equal(o.status, "ok")
})

test("price choice: preferred currency, else the first one offered with a warning; never mixes", () => {
  const opts = [
    { method: "a", currency: "EUR", price: 7.5, priceText: "7.50 €" },
    { method: "b", currency: "USD", price: 9, priceText: "9.00 $" },
    { method: "c", currency: "USD", price: 8.8, priceText: "8.80 $" },
  ]
  assert.equal(pickPrice(opts, "USD").chosen!.price, 8.8)
  assert.equal(pickPrice(opts, "eur").chosen!.price, 7.5)
  const fb = pickPrice(opts.filter(o => o.currency === "EUR"), "USD")
  assert.equal(fb.chosen!.currency, "EUR")
  assert.equal(fb.usedFallback, true)
  assert.equal(pickPrice([], "USD").chosen, undefined)
})
