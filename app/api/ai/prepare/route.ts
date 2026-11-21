import { NextResponse } from "next/server"
import { AiClient, loadChain } from "@/lib/ai/provider"
import { getStateStore } from "@/lib/state"
import { canonicalIdOf, readSourceOffer } from "@/lib/sources"
import { prepareOffer, type GameProfile, type PreparedOffer } from "@/lib/pipeline/prepare"
import { loadGameProfile } from "@/lib/gameProfile"
import { COL, readRows, sheetErrorMessage } from "@/lib/sheets"
import { errorResponse } from "@/lib/apiHelpers"

export const runtime = "nodejs"
export const maxDuration = 60

/**
 * POST /api/ai/prepare
 * { items: [{ link, price, seller }], game?: { gameId, gameSlug, gameName }, defaultDescription? }   (max 6 items per call)
 *
 * Turns each link into a reviewed-ready listing (title, description, images, price, game fields).
 * READ-ONLY: nothing is created on GameBoost and nothing is written to the sheet. Publishing stays with
 * POST /api/offers, so the existing duplicate-title check, 422 retry and sheet logging keep working.
 * The browser calls this in small chunks (progress bar), same pattern as the dead-link check.
 */

// One AI client per server instance. Cooldowns and daily token counts are kept in the sheet's state tab
// (StateStore), so every instance sees the same ones; the client syncs before each AI call.
const globalAi = globalThis as unknown as { __lsAi?: AiClient }
const ai = (globalAi.__lsAi ??= new AiClient(loadChain(), { store: getStateStore() }))

// Sheet snapshot of already-listed source ids, refreshed at most every 30 s (Sheets read quota).
// Deliberately NOT in the StateStore: it is only a read cache of the main sheet (the source of truth),
// at most 30 s stale per instance; storing it in the state tab would add a Sheets read and fix nothing.
let idCache: { at: number; ids: Map<string, string> } | null = null
async function listedIds() {
  if (idCache && Date.now() - idCache.at < 30_000) return idCache.ids
  const rows = await readRows()
  const ids = new Map<string, string>()
  for (const r of rows) {
    const id = canonicalIdOf((r.cells[COL.LINK] || "").trim())
    if (id && !ids.has(id)) ids.set(id, `sheet row ${r.rowNumber}: ${(r.cells[COL.TITLE] || "").slice(0, 60)}`)
  }
  idCache = { at: Date.now(), ids }
  return ids
}

type Item = { link?: string; price?: string; seller?: string }

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    items?: Item[]
    game?: { gameId?: number; gameSlug?: string; gameName?: string }
    defaultDescription?: string
  }
  const items = (body.items || []).filter(i => i?.link?.trim()).slice(0, 6)
  if (!items.length) return NextResponse.json({ error: "items is required" }, { status: 400 })

  let ids: Map<string, string>
  try {
    ids = await listedIds()
  } catch (e) {
    return NextResponse.json({ error: sheetErrorMessage(e) }, { status: 500 })
  }

  let game: GameProfile | null = null
  if (body.game?.gameId && body.game.gameSlug) {
    try {
      const p = await loadGameProfile({ gameId: body.game.gameId, gameSlug: body.game.gameSlug, gameName: body.game.gameName })
      game = { gameId: p.gameId, gameName: p.gameName, specs: p.specs }
    } catch (e) {
      return errorResponse(e, "POST /api/ai/prepare: loading game fields")
    }
  }

  const seenInRequest = new Set<string>()
  const results: PreparedOffer[] = []
  // 3 at a time: fast enough, gentle on the source site and on the AI provider's per-minute limits
  let n = 0
  const out: PreparedOffer[] = new Array(items.length)
  await Promise.all(
    Array.from({ length: Math.min(3, items.length) }, async () => {
      while (n < items.length) {
        const idx = n++
        const it = items[idx]
        out[idx] = await prepareOffer(
          { link: it.link!, price: it.price || "", seller: it.seller || "" },
          {
            readOffer: readSourceOffer,
            ai,
            game,
            defaultDescription: body.defaultDescription,
            isDuplicate: (id, link) => {
              void link
              if (seenInRequest.has(id)) return "repeated in this batch"
              seenInRequest.add(id)
              return ids.get(id) ?? null
            },
          }
        )
      }
    })
  )
  results.push(...out)
  return NextResponse.json({ results, aiUsage: ai.usage() })
}
