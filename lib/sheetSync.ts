import type { AccountOffer } from "@/lib/gameboost"
import { COL, ensureGameBoostHeaders, findRow, normalize, nowStamp, readRows, updateCells, type CellUpdate } from "@/lib/sheets"

/**
 * Mirror a GameBoost offer's current state into its sheet row (if it has one).
 * Pass `deleted: true` after a permanent delete.
 */
export async function mirrorToSheet(
  offer: Pick<AccountOffer, "id" | "external_id"> & Partial<AccountOffer>,
  opts: { deleted?: boolean; rowHint?: number } = {}
) {
  const rows = await readRows()
  let row = findRow(rows, offer.id, offer.external_id)
  // Older rows (listed before the app) have no GB id yet: use the row the user acted on,
  // but only if it has no other offer id and its title matches.
  if (!row && opts.rowHint && offer.title) {
    const r = rows.find(x => x.rowNumber === opts.rowHint)
    if (r && !r.cells[COL.GB_OFFER_ID] && normalize(r.cells[COL.TITLE] || "") === normalize(offer.title)) row = r
  }
  if (!row) return false

  await ensureGameBoostHeaders()
  const u: CellUpdate[] = [
    { rowNumber: row.rowNumber, col: COL.GB_OFFER_ID, value: offer.id },
    { rowNumber: row.rowNumber, col: COL.GB_STATUS, value: opts.deleted ? "deleted" : offer.status || "" },
    { rowNumber: row.rowNumber, col: COL.GB_UPDATED_AT, value: nowStamp() },
  ]
  if (!opts.deleted) {
    if (offer.title) u.push({ rowNumber: row.rowNumber, col: COL.TITLE, value: offer.title })
    if (offer.price) u.push({ rowNumber: row.rowNumber, col: COL.GB_PRICE_EUR, value: offer.price })
  }
  await updateCells(u)
  return true
}
