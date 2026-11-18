import { NextResponse } from "next/server"
import { publicOffer, publishOffer, unlistOffer } from "@/lib/gameboost"
import { errorResponse } from "@/lib/apiHelpers"
import { mirrorToSheet } from "@/lib/sheetSync"
import { googleErrorDetails } from "@/lib/sheets"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/gameboost/offers/:id/visibility  { action: "list" | "unlist" }
 * Unlist = move to draft (hidden, reversible). The safe alternative to deleting.
 */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: "Invalid offer id" }, { status: 400 })
  const { action, row } = (await req.json().catch(() => ({}))) as { action?: string; row?: number }
  if (action !== "list" && action !== "unlist") {
    return NextResponse.json({ error: 'action must be "list" or "unlist"' }, { status: 400 })
  }
  try {
    const offer = action === "list" ? await publishOffer(id) : await unlistOffer(id)
    await mirrorToSheet(offer, { rowHint: Number(row) || undefined }).catch(err => console.error("visibility: sheet mirror failed", googleErrorDetails(err)))
    return NextResponse.json({ offer: publicOffer(offer) })
  } catch (e) {
    return errorResponse(e, `${action} offer ${id}`)
  }
}
