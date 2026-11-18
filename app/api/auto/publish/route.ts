import { NextResponse } from "next/server"
import { isAuthed } from "@/lib/session"
import { POST as offersPost } from "@/app/api/offers/route"
import { gameboostDestination } from "@/lib/destinations/gameboost"
import { parsePublishRequest } from "@/lib/auto/publishRequest"

export const runtime = "nodejs"
// Same budget as POST /api/offers (it runs inside this request)
export const maxDuration = 60

/**
 * POST /api/auto/publish
 *   { items: PublishItem[] (max 20), settings: { listNow, deliveryDuration, deliveryUnit, defaultDescription?, deliveryInstructions? } }
 *   -> { results: PublishResult[], listNow }
 * Called only when the user presses Publish on /auto (after a confirmation). Runs the existing POST /api/offers code
 * in-process (duplicate-title check, 422 retry, sheet logging). listNow false (the default) = create as drafts.
 */
export async function POST(req: Request) {
  if (!(await isAuthed(req))) return NextResponse.json({ error: "Not logged in" }, { status: 401 })
  const input = parsePublishRequest(await req.json().catch(() => null))
  if ("error" in input) return NextResponse.json({ error: input.error }, { status: 400 })

  const dest = gameboostDestination(async body => {
    const res = await offersPost(new Request(new URL("/api/offers", req.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> }
  })
  const results = await dest.publish(input.items, input.settings)
  console.log(`auto publish: ${results.map(r => `${r.ref}=${r.status}${r.offerId ? `#${r.offerId}` : ""}`).join(" ")}`)
  return NextResponse.json({ results, listNow: input.settings.listNow })
}
