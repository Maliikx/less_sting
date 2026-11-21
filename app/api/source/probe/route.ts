import { NextResponse } from "next/server"
import { isAuthed } from "@/lib/session"
import { parseProbeRequest, probeLinks } from "@/lib/sources/probe"

export const runtime = "nodejs"
// 5 links x (1.5 s gap + up to ~15 s page time) worst case stays under this.
export const maxDuration = 120

/**
 * POST /api/source/probe  { links: string[] (max 5), includeHtml?: boolean }
 *   -> { rows: ProbeRow[] }
 * Read-only check of source pages from this server. One request to the site every 1.5 s.
 * The browser sends small chunks and waits between them.
 */
export async function POST(req: Request) {
  // proxy.ts already requires a session for /api; checked again here so the route is safe on its own.
  if (!(await isAuthed(req))) return NextResponse.json({ error: "Not logged in" }, { status: 401 })

  const input = parseProbeRequest(await req.json().catch(() => null))
  if ("error" in input) return NextResponse.json({ error: input.error }, { status: 400 })

  const rows = await probeLinks(input.links, { includeHtml: input.includeHtml })
  // Log counts only: never full page contents.
  console.log(`probe: ${rows.length} link(s): ${rows.map(r => `${r.lotId || "?"}=${r.status}`).join(" ")}`)
  return NextResponse.json({ rows })
}
