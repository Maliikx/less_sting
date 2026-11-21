import { NextResponse } from "next/server"
import { getTemplate } from "@/lib/gameboost"
import { errorResponse } from "@/lib/apiHelpers"
import { deepFind, extractAccountData, requiredFromTemplate } from "@/lib/template"

export const runtime = "nodejs"

/**
 * GET /api/gameboost/template?game=<slug>
 * Returns the listing-detail fields GameBoost expects for this game, so the form can show them.
 * The raw template is returned too, for reference.
 */
export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("game")
  if (!slug) return NextResponse.json({ error: "game is required" }, { status: 400 })
  try {
    const raw = await getTemplate(slug)
    const gameItems = deepFind(raw, ["game_items"]) ?? null
    const accountData = extractAccountData(raw)
    return NextResponse.json({ accountData, required: requiredFromTemplate(accountData), gameItems, raw })
  } catch (e) {
    return errorResponse(e, "GET /api/gameboost/template")
  }
}
