import test from "node:test"
import assert from "node:assert/strict"
import {
  actionTargets, canPublishRow, isSelectable, newRow, pruneSelection, repeatedRows, rowProblem, rowsFromPaste, rowsToPrepare,
  selectAll, selectCreated, selectReady, type ResultRow,
} from "../lib/auto/rows"
import { EMPLOYEES } from "../lib/employees"

const L = (id: string) => `https://funpay.com/en/lots/offer?id=${id}`

/* ------------------------------------------------------------ the 3 input fields */

test("input rows: link + price (number or multiplier) + seller; empty rows ignored; problems named", () => {
  assert.equal(rowProblem(newRow()), null, "an empty row is not an error")
  assert.equal(rowProblem(newRow({ link: L("81847225"), price: "x1.5", seller: "M" })), null)
  assert.equal(rowProblem(newRow({ link: L("81847225"), price: "12,5", seller: "M" })), null)
  assert.equal(rowProblem(newRow({ link: L("81847225"), price: "2x", seller: "M" })), null)
  assert.equal(rowProblem(newRow({ price: "10", seller: "M" })), null, "a row with only the shared price/seller is just unused")
  assert.equal(rowProblem(newRow({ link: "https://funpay.com/en/lots/346/", price: "10", seller: "M" })), "not a FunPay single-offer link")
  assert.equal(rowProblem(newRow({ link: L("81847225"), seller: "M" })), "price is missing")
  assert.equal(rowProblem(newRow({ link: L("81847225"), price: "ten", seller: "M" })), "price must be a number or a multiplier like x2")
  assert.equal(rowProblem(newRow({ link: L("81847225"), price: "10" })), "pick the seller")
})

test("input rows: same offer twice -> second row marked; only valid first rows are prepared", () => {
  const rows = [
    newRow({ link: L("111222"), price: "10", seller: "M" }),
    newRow({ link: "https://funpay.com/ru/lots/offer?id=111222", price: "20", seller: "V" }),
    newRow({ link: L("333444"), price: "x2", seller: "G" }),
    newRow({ link: L("555666"), price: "", seller: "G" }),
    newRow(),
  ]
  assert.deepEqual([...repeatedRows(rows)], [rows[1].id])
  assert.deepEqual(rowsToPrepare(rows), [
    { key: "funpay:111222", link: L("111222"), price: "10", seller: "M" },
    { key: "funpay:333444", link: L("333444"), price: "x2", seller: "G" },
  ])
})

test("paste many links: price/seller optional per line, else the 'for all' values; unknown seller codes not invented", () => {
  const rows = rowsFromPaste([`${L("111222")} x1.5 ms`, L("333444"), "", `${L("555666")}\t30\tNOPE`, "no link here"].join("\n"), { price: "x2", seller: "V" }, EMPLOYEES)
  assert.deepEqual(rows.map(r => [r.link, r.price, r.seller]), [
    [L("111222"), "x1.5", "Ms"],
    [L("333444"), "x2", "V"],
    [L("555666"), "30", "V"],
  ])
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
  assert.deepEqual([...selectReady(ROWS)], ["r1"])
  assert.deepEqual([...selectCreated(ROWS)], ["c5", "c6"])
  assert.deepEqual([...selectAll(ROWS)], ["r1", "c5", "c6"])
  assert.deepEqual(ROWS.filter(isSelectable).map(r => r.key), ["r1", "c5", "c6"])
  assert.equal(canPublishRow(row("x", { result: { ref: "x", status: "created", offerId: 1, offerStatus: "draft" } })), false, "already published")
})

test("buttons: Publish / List now / Back to draft / Delete each act only on rows they fit", () => {
  const all = new Set(ROWS.map(r => r.key))
  const t = actionTargets(ROWS, all)
  assert.deepEqual(t.publish.map(r => r.key), ["r1"])
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
