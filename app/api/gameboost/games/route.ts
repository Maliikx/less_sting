import { NextResponse } from "next/server"
import { listGames } from "@/lib/gameboost"
import { errorResponse } from "@/lib/apiHelpers"

export const runtime = "nodejs"

/** GET /api/gameboost/games?search=valorant */
export async function GET(req: Request) {
  const search = new URL(req.url).searchParams.get("search") || undefined
  try {
    const games = await listGames(search)
    return NextResponse.json({ games: games.map(g => ({ id: g.id, name: g.name, slug: g.slug })) })
  } catch (e) {
    return errorResponse(e, "GET /api/gameboost/games")
  }
}
