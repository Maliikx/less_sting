import { canonicalIdOf } from "../sources/index"
import { isMultiplier } from "../offerRules"
import { parseLine } from "./lines"
import type { PreparedOffer } from "../pipeline/prepare"
import type { PublishResult } from "../destinations/types"

/* ------------------------------------------------------------ input rows (the 3 fields) */

/** One offer line: link + price. The seller is chosen ONCE for the whole batch (each seller lists for themselves). */
export type InputRow = { id: string; link: string; price: string }

let seq = 0
export const newRow = (o: Partial<InputRow> = {}): InputRow => ({ id: `r${Date.now().toString(36)}${(seq++).toString(36)}`, link: "", price: "", ...o })

const PRICE_OK = /^\d+(?:[.,]\d+)?$/

/** Problem with one row's own fields, or null. Rows without a link are unused rows (null), even with a price from "Price for all". */
export function rowProblem(r: InputRow): string | null {
  if (!r.link.trim()) return null
  if (!canonicalIdOf(r.link)) return "not a FunPay single-offer link"
  const p = r.price.trim()
  if (!p) return "price is missing"
  if (!isMultiplier(p) && !PRICE_OK.test(p)) return "price must be a number or a multiplier like x2"
  return null
}

/** Row ids whose link is the same offer as an earlier row (same lot id). */
export function repeatedRows(rows: InputRow[]): Set<string> {
  const seen = new Set<string>()
  const out = new Set<string>()
  for (const r of rows) {
    const id = canonicalIdOf(r.link)
    if (!id) continue
    if (seen.has(id)) out.add(r.id)
    seen.add(id)
  }
  return out
}

/** Rows ready to send to Prepare (valid, first per lot id), all for the batch's seller. None without a seller. */
export function rowsToPrepare(rows: InputRow[], seller: string) {
  if (!seller) return []
  const rep = repeatedRows(rows)
  return rows
    .filter(r => r.link.trim() && !rep.has(r.id) && !rowProblem(r))
    .map(r => ({ key: canonicalIdOf(r.link)!, link: r.link.trim(), price: r.price.trim().replace(",", "."), seller }))
}

/**
 * "Paste many links": one per line, `link [price]` (tabs/commas OK; other words on the line are ignored).
 * A missing price is taken from "Price for all".
 */
export function rowsFromPaste(text: string, defaultPrice = ""): InputRow[] {
  const out: InputRow[] = []
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue
    const l = parseLine(raw, i + 1)
    if (!l.link) continue
    out.push(newRow({ link: l.link, price: l.price || defaultPrice }))
  }
  return out
}

/* ------------------------------------------------------------ results table: selection + actions */

export type ResultRow = PreparedOffer & { key: string; result?: PublishResult; deleted?: boolean; busy?: boolean; actionError?: string }

const created = (r: ResultRow) => r.result?.status === "created" && !!r.result.offerId && !r.deleted
export const isDraft = (r: ResultRow) => created(r) && r.result!.offerStatus === "draft"
export const isListed = (r: ResultRow) => created(r) && r.result!.offerStatus === "listed"
export const canPublishRow = (r: ResultRow) => r.status === "ready" && !!r.game && !r.result
/** Rows that can be ticked at all: something can still be done with them. */
export const isSelectable = (r: ResultRow) => canPublishRow(r) || created(r)

export function selectReady(rows: ResultRow[]) {
  return new Set(rows.filter(canPublishRow).map(r => r.key))
}
export function selectCreated(rows: ResultRow[]) {
  return new Set(rows.filter(created).map(r => r.key))
}
export function selectAll(rows: ResultRow[]) {
  return new Set(rows.filter(isSelectable).map(r => r.key))
}

/** What each action button would act on, given the ticked rows. Buttons show these counts and disable at 0. */
export function actionTargets(rows: ResultRow[], selected: Set<string>) {
  const sel = rows.filter(r => selected.has(r.key) && !r.busy)
  return {
    publish: sel.filter(canPublishRow),
    listNow: sel.filter(isDraft),
    unlist: sel.filter(isListed),
    remove: sel.filter(created),
  }
}

/** Keep the selection valid after rows change (drop rows that can no longer be acted on). */
export function pruneSelection(rows: ResultRow[], selected: Set<string>) {
  const ok = new Set(rows.filter(isSelectable).map(r => r.key))
  return new Set([...selected].filter(k => ok.has(k)))
}
