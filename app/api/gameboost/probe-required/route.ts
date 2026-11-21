import { NextResponse } from "next/server"
import { errorMessage, GameBoostError } from "@/lib/gameboost"
import { probeRequired } from "@/lib/probeRequired"

export const runtime = "nodejs"

/**
 * POST /api/gameboost/probe-required  { gameId: number }
 * Finds out which listing details GameBoost requires for a game. Logic lives in lib/probeRequired.ts.
 */
export async function POST(req: Request) {
  const { gameId } = (await req.json().catch(() => ({}))) as { gameId?: number }
  if (!Number.isInteger(gameId) || (gameId as number) <= 0) {
    return NextResponse.json({ error: "gameId is required" }, { status: 400 })
  }
  try {
    const r = await probeRequired(gameId!)
    return NextResponse.json({ required: r.requiredFields, fields: r.fields, messages: r.messages })
  } catch (e) {
    console.error("probe-required:", errorMessage(e))
    return NextResponse.json({ error: errorMessage(e) }, { status: e instanceof GameBoostError && e.status >= 400 && e.status !== 401 ? e.status : 502 })
  }
}
