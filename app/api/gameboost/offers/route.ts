import { NextResponse } from "next/server"
import { listOffers, publicOffer } from "@/lib/gameboost"
import { errorResponse } from "@/lib/apiHelpers"
import { COL, findRow, googleErrorDetails, readRows } from "@/lib/sheets"

export const runtime = "nodejs"

/**
 * GET /api/gameboost/offers?search=&status=&page=<links.next URL>
 * Offers straight from GameBoost (the live truth), joined with the sheet row
 * (employee, source link) via GB_OFFER_ID / EXTERNAL_ID.
 */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams
  try {
    const page = await listOffers({
      search: sp.get("search") || undefined,
      status: sp.get("status") || undefined,
      pageUrl: sp.get("page") || undefined,
      perPage: 25,
    })

    let rows: Awaited<ReturnType<typeof readRows>> = []
    try {
      rows = await readRows()
    } catch (err) {
      console.error("offers list: sheet read failed", googleErrorDetails(err))
    }

    const offers = (page.data || []).map(o => {
      const row = findRow(rows, o.id, o.external_id)
      return {
        ...publicOffer(o),
        sheet: row
          ? {
              row: row.rowNumber,
              employee: row.cells[COL.EMPLOYEE] || "",
              link: row.cells[COL.LINK] || "",
              note: row.cells[COL.NOTE] || "",
            }
          : null,
      }
    })

    return NextResponse.json({
      offers,
      total: page.meta?.total ?? null,
      currentPage: page.meta?.current_page ?? null,
      lastPage: page.meta?.last_page ?? null,
      next: page.links?.next || null,
      prev: page.links?.prev || null,
    })
  } catch (e) {
    return errorResponse(e, "GET /api/gameboost/offers")
  }
}
