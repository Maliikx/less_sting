import { NextResponse } from "next/server"
import { listOffers, type AccountOffer } from "@/lib/gameboost"
import { errorResponse } from "@/lib/apiHelpers"
import { checkSource } from "@/lib/sourcePage"
import { COL, normalize, readRows, sheetErrorMessage } from "@/lib/sheets"

export const runtime = "nodejs"
export const maxDuration = 60

/** Statuses an offer can be deleted in. Sold/processing/refunded are never touched. */
const LIVE = ["listed", "draft", "pending"]

type Item = { row: number; gbId: number; title: string; link: string; employee: string }

/**
 * Two steps, so 2000+ offers can be checked with a progress bar and no request runs too long:
 *
 * 1. POST { action: "prepare" }
 *    Reads the sheet, loads every live GameBoost offer, and matches each sheet row to its offer:
 *    by GB_OFFER_ID (offers made by this app), otherwise by TITLE (offers listed before the app).
 *    READ ONLY: nothing is changed on GameBoost or in the sheet. Changes happen only when the
 *    user confirms a delete/unlist (then the sheet row is updated for that offer).
 *    Returns the list of { row, gbId, title, link } to check.
 *
 * 2. POST { action: "check", items: [...] }   (up to 40 at a time)
 *    Opens each link and returns ok / not_found / error.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { action?: string; items?: Item[] }
  if (body.action === "check") return check(body.items || [])
  return prepare()
}

async function loadLiveOffers() {
  const all: AccountOffer[] = []
  for (const status of LIVE) {
    let page = await listOffers({ status, perPage: 50 })
    all.push(...(page.data || []))
    let guard = 0
    while (page.links?.next && guard++ < 400) {
      page = await listOffers({ pageUrl: page.links.next })
      all.push(...(page.data || []))
    }
  }
  // De-duplicate and re-check the status ourselves (in case a filter is ignored)
  const seen = new Set<number>()
  return all.filter(o => LIVE.includes(String(o.status)) && !seen.has(o.id) && !!seen.add(o.id))
}

async function prepare() {
  let rows
  try {
    rows = await readRows()
  } catch (err) {
    return NextResponse.json({ error: sheetErrorMessage(err) }, { status: 500 })
  }

  let offers: AccountOffer[]
  try {
    offers = await loadLiveOffers()
  } catch (e) {
    return errorResponse(e, "check-links: loading GameBoost offers")
  }

  const byId = new Map(offers.map(o => [String(o.id), o]))
  const byTitle = new Map<string, AccountOffer[]>()
  for (const o of offers) {
    const t = normalize(o.title || "")
    byTitle.set(t, [...(byTitle.get(t) || []), o])
  }

  const items: Item[] = []
  const usedIds = new Set<number>()
  let noLink = 0
  let notOnGameBoost = 0
  let ambiguous = 0
  let matchedByTitle = 0

  for (const r of rows) {
    const link = (r.cells[COL.LINK] || "").trim()
    const status = (r.cells[COL.GB_STATUS] || "").toLowerCase()
    if (status === "deleted") continue
    if (!/^https?:\/\//i.test(link)) {
      noLink++
      continue
    }

    let offer: AccountOffer | undefined
    const id = r.cells[COL.GB_OFFER_ID]
    if (/^\d+$/.test(id || "")) {
      offer = byId.get(id)
    } else {
      const matches = (byTitle.get(normalize(r.cells[COL.TITLE] || "")) || []).filter(o => !usedIds.has(o.id))
      if (matches.length > 1) {
        ambiguous++ // same title on several GameBoost offers: can't tell which one belongs to this link
        continue
      }
      offer = matches[0]
      if (offer) matchedByTitle++
    }
    if (!offer) {
      notOnGameBoost++ // sold, deleted, or never listed: nothing to delete
      continue
    }
    if (usedIds.has(offer.id)) continue
    usedIds.add(offer.id)
    items.push({
      row: r.rowNumber,
      gbId: offer.id,
      title: offer.title || r.cells[COL.TITLE] || "",
      link,
      employee: r.cells[COL.EMPLOYEE] || "",
    })
  }

  return NextResponse.json({
    items,
    stats: {
      sheetRows: rows.length,
      liveOffers: offers.length,
      toCheck: items.length,
      matchedByTitle,
      notOnGameBoost,
      ambiguous,
      noLink,
    },
  })
}

async function check(items: Item[]) {
  const batch = items.slice(0, 40).filter(i => /^https?:\/\//i.test(i?.link || ""))
  const results: (Item & { status: string; message?: string })[] = []
  // Several at a time: fast, but gentle enough that the source site doesn't block us
  const CONCURRENCY = 6
  let n = 0
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (n < batch.length) {
        const it = batch[n++]
        const r = await checkSource(it.link)
        results.push({ ...it, status: r.status, message: r.message })
      }
    })
  )
  results.sort((a, b) => a.row - b.row)
  return NextResponse.json({ results })
}
