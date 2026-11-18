import { NextResponse } from "next/server"
import { GameBoostError, getOffer, listOffers, type AccountOffer } from "@/lib/gameboost"
import { errorResponse } from "@/lib/apiHelpers"
import { isAuthed } from "@/lib/session"
import { COL, ensureGameBoostHeaders, nowStamp, readRows, updateCells, type CellUpdate } from "@/lib/sheets"

export const runtime = "nodejs"
export const maxDuration = 60

/**
 * Refresh GB_STATUS / GB_PRICE_EUR / TITLE in the sheet from GameBoost.
 * Catches offers that sold, or were edited/deleted on the GameBoost website.
 *
 *  - From the app: "Refresh sheet from GameBoost" button (uses the login session)
 *  - On a schedule: GET with header `Authorization: Bearer $CRON_SECRET`
 *    (Vercel Cron sends this automatically when CRON_SECRET is set - see vercel.json)
 *
 * Reads only (1 request per 50 offers), so it is cheap on the rate limits.
 */
async function authorized(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get("authorization") === `Bearer ${secret}`) return true
  return isAuthed(req)
}

async function run() {
  const rows = await readRows()
  const tracked = rows.filter(r => /^\d+$/.test(r.cells[COL.GB_OFFER_ID] || "") && r.cells[COL.GB_STATUS] !== "deleted")
  if (!tracked.length) return { checked: 0, updated: 0, missing: 0 }

  const remote = new Map<string, AccountOffer>()
  const ids = tracked.map(r => r.cells[COL.GB_OFFER_ID])
  for (let i = 0; i < ids.length; i += 50) {
    const page = await listOffers({ ids: ids.slice(i, i + 50), perPage: 50 })
    for (const o of page.data || []) remote.set(String(o.id), o)
  }

  const now = nowStamp()
  const updates: CellUpdate[] = []
  let updated = 0
  let missing = 0
  let lookups = 0

  for (const row of tracked) {
    const id = row.cells[COL.GB_OFFER_ID]
    let o = remote.get(id)

    if (!o) {
      // Not returned by the list filter. Confirm with a direct lookup before calling it deleted.
      if (lookups++ >= 20) continue
      try {
        o = await getOffer(id)
      } catch (e) {
        if (e instanceof GameBoostError && e.status === 404) {
          missing++
          updates.push(
            { rowNumber: row.rowNumber, col: COL.GB_STATUS, value: "deleted" },
            { rowNumber: row.rowNumber, col: COL.GB_UPDATED_AT, value: now }
          )
        }
        continue
      }
    }

    const changed =
      (row.cells[COL.GB_STATUS] || "") !== o.status ||
      (row.cells[COL.GB_PRICE_EUR] || "") !== String(o.price ?? "") ||
      (row.cells[COL.TITLE] || "") !== o.title
    if (!changed) continue
    updated++
    updates.push(
      { rowNumber: row.rowNumber, col: COL.GB_STATUS, value: o.status },
      { rowNumber: row.rowNumber, col: COL.GB_PRICE_EUR, value: String(o.price ?? "") },
      { rowNumber: row.rowNumber, col: COL.TITLE, value: o.title },
      { rowNumber: row.rowNumber, col: COL.GB_UPDATED_AT, value: now }
    )
  }

  if (updates.length) {
    await ensureGameBoostHeaders()
    await updateCells(updates)
  }
  return { checked: tracked.length, updated, missing }
}

async function handler(req: Request) {
  if (!(await authorized(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    return NextResponse.json({ success: true, ...(await run()) })
  } catch (e) {
    return errorResponse(e, "sync")
  }
}

export const GET = handler
export const POST = handler
