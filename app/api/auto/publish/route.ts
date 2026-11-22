import { NextResponse } from "next/server"
import { isAuthed } from "@/lib/session"
import { POST as offersPost } from "@/app/api/offers/route"
import { gameboostDestination, sameTitle, sheetRowForExisting } from "@/lib/destinations/gameboost"
import { parsePublishRequest } from "@/lib/auto/publishRequest"
import { listOffers } from "@/lib/gameboost"
import { getStateStore } from "@/lib/state"
import { rememberLearnedTypes } from "@/lib/auto/gameProfileCache"
import { COL, ensureGameBoostHeaders, normalize, nowStamp, readRows, writeRowsAt } from "@/lib/sheets"

export const runtime = "nodejs"
// The browser sends 3 offers per call; this is a generous ceiling (Vercel Pro allows it).
export const maxDuration = 300

/**
 * POST /api/auto/publish
 *   { items: PublishItem[] (max 20; the page sends 3), settings: { listNow, deliveryDuration, deliveryUnit, defaultDescription?, deliveryInstructions? } }
 *   -> { results: PublishResult[], listNow }
 * Called only when the user presses Publish on /auto (after a confirmation). Runs the existing POST /api/offers code
 * in-process (duplicate-title check, 422 retry, sheet logging). listNow false (the default) = create as drafts.
 *
 * Safe to retry after a timeout: before creating, each title is looked up on GameBoost. An offer that is already
 * there but missing from the sheet (an interrupted publish) is not created again; its sheet row is appended.
 */
export async function POST(req: Request) {
  if (!(await isAuthed(req))) return NextResponse.json({ error: "Not logged in" }, { status: 401 })
  const input = parsePublishRequest(await req.json().catch(() => null))
  if ("error" in input) return NextResponse.json({ error: input.error }, { status: 400 })

  // Titles already in the sheet are left to POST /api/offers' own duplicate check.
  let sheetTitles: Set<string>
  try {
    sheetTitles = new Set((await readRows()).map(r => normalize(r.cells[COL.TITLE] || "")))
  } catch (e) {
    return NextResponse.json({ error: `Could not read the sheet: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 })
  }

  const dest = gameboostDestination(
    async body => {
      const res = await offersPost(new Request(new URL("/api/offers", req.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))
      return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> }
    },
    {
      findExisting: async item => {
        if ([...sheetTitles].some(t => sameTitle(t, item.title))) return null
        const page = await listOffers({ search: item.title.slice(0, 120), perPage: 20 })
        const hit = (page.data || []).find(o => sameTitle(o.title, item.title) && o.status !== "archived")
        return hit ? { id: hit.id, status: hit.status, externalId: hit.external_id, price: hit.price } : null
      },
      onLearnedTypes: async (game, types) => {
        const changed = await rememberLearnedTypes(getStateStore(), game.id, types)
        if (changed) console.log(`auto publish: learned field types for ${game.name}: ${Object.entries(types).map(([k, v]) => `${k}=${v}`).join(", ")}`)
      },
      logExisting: async found => {
        await ensureGameBoostHeaders()
        const now = nowStamp()
        const nextRow = (await readRows()).length + 2 // re-read right before writing, same as POST /api/offers
        await writeRowsAt(nextRow, found.map(f => sheetRowForExisting(f.item, f.offer, now)))
      },
    }
  )
  const results = await dest.publish(input.items, input.settings)
  console.log(`auto publish: ${results.map(r => `${r.ref}=${r.status}${r.offerId ? `#${r.offerId}` : ""}`).join(" ")}`)
  return NextResponse.json({ results, listNow: input.settings.listNow })
}
