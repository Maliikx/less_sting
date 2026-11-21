import { NextResponse } from "next/server"
import { isAuthed } from "@/lib/session"
import { defaultImageProblem } from "@/lib/auto/defaultImages"
import { getDefaultImageStore } from "@/lib/auto/defaultImagesServer"

export const runtime = "nodejs"

/** GET /api/auto/default-image -> { images: [{ gameId, gameName, url, updatedAt }] } */
export async function GET(req: Request) {
  if (!(await isAuthed(req))) return NextResponse.json({ error: "Not logged in" }, { status: 401 })
  try {
    return NextResponse.json({ images: [...(await getDefaultImageStore().all()).values()] })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

/**
 * POST /api/auto/default-image { gameId, gameName, url }
 * Saves (or replaces) the default image for one game in the sheet's own DEFAULT_IMG tab.
 */
export async function POST(req: Request) {
  if (!(await isAuthed(req))) return NextResponse.json({ error: "Not logged in" }, { status: 401 })
  const b = (await req.json().catch(() => ({}))) as { gameId?: unknown; gameName?: unknown; url?: unknown }
  const gameId = Number(b.gameId)
  const url = typeof b.url === "string" ? b.url.trim() : ""
  const gameName = typeof b.gameName === "string" ? b.gameName.trim().slice(0, 120) : ""
  if (!Number.isInteger(gameId) || gameId <= 0) return NextResponse.json({ error: "gameId is required" }, { status: 400 })
  const problem = defaultImageProblem(url)
  if (problem) return NextResponse.json({ error: problem }, { status: 400 })
  try {
    await getDefaultImageStore().set({ gameId, gameName, url })
    return NextResponse.json({ ok: true, image: { gameId, gameName, url } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
