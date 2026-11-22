import test from "node:test"
import assert from "node:assert/strict"
import {
  actionTargets, canPublishRow, isSelectable, newRow, pruneSelection, rowProblem, rowsFromPaste, rowsToPrepare,
  selectAll, selectCreated, selectReady, type ResultRow,
} from "../lib/auto/rows"

const L = (id: string) => `https://funpay.com/en/lots/offer?id=${id}`

/* ------------------------------------------------------------ input rows: link + price (seller once per batch) */

test("input rows: link + price (number or multiplier); rows without a link are unused; problems named", () => {
  assert.equal(rowProblem(newRow()), null, "an empty row is not an error")
  assert.equal(rowProblem(newRow({ price: "10" })), null, "a row with only the shared price is just unused")
  assert.equal(rowProblem(newRow({ link: L("81847225"), price: "x1.5" })), null)
  assert.equal(rowProblem(newRow({ link: L("81847225"), price: "12,5" })), null)
  assert.equal(rowProblem(newRow({ link: L("81847225"), price: "2x" })), null)
  assert.equal(rowProblem(newRow({ link: "https://funpay.com/en/lots/346/", price: "10" })), "not a FunPay single-offer link")
  assert.equal(rowProblem(newRow({ link: L("81847225") })), "price is missing")
  assert.equal(rowProblem(newRow({ link: L("81847225"), price: "ten" })), "price must be a number or a multiplier like x2")
})

test("input rows: one seller for the whole batch; the same link twice is NOT blocked (titles decide); nothing without a seller", () => {
  const rows = [
    newRow({ link: L("111222"), price: "10" }),
    newRow({ link: "https://funpay.com/ru/lots/offer?id=111222", price: "20" }),
    newRow({ link: L("333444"), price: "x2" }),
    newRow({ link: L("555666"), price: "" }),
    newRow(),
  ]
  const out = rowsToPrepare(rows, "GS")
  assert.deepEqual(out.map(r => [r.link, r.price, r.seller]), [
    [L("111222"), "10", "GS"],
    ["https://funpay.com/ru/lots/offer?id=111222", "20", "GS"],
    [L("333444"), "x2", "GS"],
  ])
  assert.deepEqual(out.map(r => r.key), [rows[0].id, rows[1].id, rows[2].id], "each row keeps its own key")
  assert.deepEqual(rowsToPrepare(rows, ""), [], "no seller chosen -> nothing to prepare")
})

test("paste many links: price optional per line (else 'Price for all'); other words ignored", () => {
  const rows = rowsFromPaste([`${L("111222")} x1.5 Ms`, L("333444"), "", `${L("555666")}\t30`, "no link here"].join("\n"), "x2")
  assert.deepEqual(rows.map(r => [r.link, r.price]), [[L("111222"), "x1.5"], [L("333444"), "x2"], [L("555666"), "30"]])
})

test("title diff: shows exactly the words cleaning removed; spacing/emoji spacing is not a change", async () => {
  const { diffWords, titleChanged } = await import("../lib/auto/diff")
  const emoji = diffWords("🔥Fortnite Account | Instant Delivery", "🔥 Fortnite Account")
  assert.deepEqual(emoji.filter(p => p.kind === "removed").map(p => p.text).join(" "), "| Instant Delivery", "emoji spacing is not a removal")
  const parts = diffWords("Fortnite Account | Instant Delivery | 200 skins | Warranty", "Fortnite Account | 200 skins")
  assert.deepEqual(parts.filter(p => p.kind === "removed").map(p => p.text), ["Instant Delivery |", "| Warranty"])
  assert.equal(parts.filter(p => p.kind === "same").map(p => p.text).join(" "), "Fortnite Account | 200 skins")
  assert.equal(titleChanged("Blood  Raven X-Suit", "Blood Raven X-Suit"), false)
  assert.equal(titleChanged("Blood Raven | FunPay", "Blood Raven"), true)
})

/* ------------------------------------------------------------ buttons: selection + action targets */

function row(key: string, o: Partial<ResultRow> = {}): ResultRow {
  return {
    key, canonicalId: key, link: L(key), seller: "M", priceInput: "10", status: "ready", title: `t${key}`, description: "d", images: ["https://x/1.jpg"],
    accountData: {}, defaulted: [], removed: [], original: {}, flags: [], language: "en", aiUsed: false, tokens: 0,
    game: { id: 1, slug: "g", name: "G" }, ...o,
  } as ResultRow
}
const created = (key: string, offerStatus: string, o: Partial<ResultRow> = {}) => row(key, { result: { ref: key, status: "created", offerId: Number(key.replace(/\D/g, "")) || 1, offerStatus }, ...o })

const ROWS: ResultRow[] = [
  row("r1"), // ready
  row("r2", { status: "needs_review" }),
  row("r3", { game: null }), // ready but no game -> not publishable
  row("r4", { status: "duplicate" }),
  created("c5", "draft"),
  created("c6", "listed"),
  created("c7", "draft", { deleted: true }),
  row("f8", { result: { ref: "f8", status: "failed", error: "x" } }),
]

test("buttons: Select all ready / Select created / header 'select all' pick exactly the right rows", () => {
  assert.deepEqual([...selectReady(ROWS)], ["r1", "f8"], "a failed publish can be fixed and published again")
  assert.deepEqual([...selectCreated(ROWS)], ["c5", "c6"])
  assert.deepEqual([...selectAll(ROWS)], ["r1", "c5", "c6", "f8"])
  assert.deepEqual(ROWS.filter(isSelectable).map(r => r.key), ["r1", "c5", "c6", "f8"])
  assert.equal(canPublishRow(row("x", { result: { ref: "x", status: "created", offerId: 1, offerStatus: "draft" } })), false, "already published")
})

test("buttons: Publish / List now / Back to draft / Delete each act only on rows they fit", () => {
  const all = new Set(ROWS.map(r => r.key))
  const t = actionTargets(ROWS, all)
  assert.deepEqual(t.publish.map(r => r.key), ["r1", "f8"])
  assert.deepEqual(t.listNow.map(r => r.key), ["c5"])
  assert.deepEqual(t.unlist.map(r => r.key), ["c6"])
  assert.deepEqual(t.remove.map(r => r.key), ["c5", "c6"], "deleted rows are not deleted twice")
  const none = actionTargets(ROWS, new Set())
  assert.deepEqual([none.publish.length, none.listNow.length, none.unlist.length, none.remove.length], [0, 0, 0, 0])
  const working = actionTargets([created("c9", "draft", { busy: true })], new Set(["c9"]))
  assert.equal(working.listNow.length, 0, "a row being worked on is not acted on twice")
})

test("buttons: after publishing or deleting, the selection drops rows that can no longer be acted on", () => {
  const sel = new Set(["r1", "c5", "c7", "r2"])
  assert.deepEqual([...pruneSelection(ROWS, sel)], ["r1", "c5"])
})

test("failed publish: GameBoost's complaints are read per field; typed values keep the field's type", async () => {
  const { badFieldsOf, parseFieldInput } = await import("../lib/auto/rows")
  const failed = row("f9", {
    result: { ref: "f9", status: "failed", error: "The selected account data.server is invalid. (and 1 more error) | account_data.server: ... | request_id 51ee | check: server, is_ranked_ready" },
  })
  assert.deepEqual(badFieldsOf(failed), ["server", "is_ranked_ready"])
  assert.deepEqual(badFieldsOf(row("x", { result: { ref: "x", status: "failed", error: "422 | missing: rank" } })), ["rank"])
  assert.deepEqual(badFieldsOf(row("y")), [])
  assert.equal(parseFieldInput("true", false), true)
  assert.equal(parseFieldInput("no", true), false)
  assert.equal(parseFieldInput("42", 0), 42)
  assert.equal(parseFieldInput("abc", 7), 7, "not a number: keep the old value")
  assert.deepEqual(parseFieldInput("PC, PlayStation", ["PC"]), ["PC", "PlayStation"])
  assert.equal(parseFieldInput(" EUW ", "Europe"), "EUW")
})
