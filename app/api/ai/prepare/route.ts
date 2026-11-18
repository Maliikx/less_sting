import { NextResponse } from "next/server"
import { AiClient, loadChain } from "@/lib/ai/provider"
import { getStateStore } from "@/lib/state"
import { canonicalIdOf, readSourceOffer } from "@/lib/sources"
import type { GameProfile } from "@/lib/pipeline/prepare"
import { loadGameProfile } from "@/lib/gameProfile"
import { listGames } from "@/lib/gameboost"
import { COL, readRows, sheetErrorMessage } from "@/lib/sheets"
import { errorResponse } from "@/lib/apiHelpers"
import { isAuthed } from "@/lib/session"
import { isGameRef, resolveGame, type GameRef } from "@/lib/auto/games"
import { PREPARE_MAX_ITEMS, prepareBatch } from "@/lib/auto/batch"

export const runtime = "nodejs"
// 6 offers x (1.5 s gap + page + possible album + one AI call) stays well under this
export const maxDuration = 120

/**
 * POST /api/ai/prepare
 * { items: [{ link, price, seller }] (max 6), picks?: { [categoryId]: {id, slug, name} }, game?: {gameId, gameSlug, gameName}, defaultDescription? }
 *
 * Turns each link into a review-ready listing (title, description, images, price, game fields).
 * READ-ONLY for GameBoost and the main sheet. Publishing is /api/auto/publish -> the existing POST /api/offers.
 * Offers are read ONE AT A TIME, 1.5 s apart (FunPay rule); the browser also waits between calls.
 * The game comes from each offer's FunPay category (remembered in the state tab), or `game` for all.
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

async function profileFor(g: GameRef): Promise<GameProfile> {
  const p = await loadGameProfile({ gameId: g.id, gameSlug: g.slug, gameName: g.name })
  return { gameId: g.id, gameSlug: g.slug, gameName: g.name, specs: p.specs }
}

export async function POST(req: Request) {
  if (!(await isAuthed(req))) return NextResponse.json({ error: "Not logged in" }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as {
    items?: Item[]
    picks?: Record<string, GameRef>
    game?: { gameId?: number; gameSlug?: string; gameName?: string }
    defaultDescription?: string
  }
  const items = (body.items || []).filter(i => i?.link?.trim())
  if (!items.length) return NextResponse.json({ error: "items is required" }, { status: 400 })
  if (items.length > PREPARE_MAX_ITEMS) return NextResponse.json({ error: `At most ${PREPARE_MAX_ITEMS} items per request` }, { status: 400 })

  let ids: Map<string, string>
  try {
    ids = await listedIds()
  } catch (e) {
    return NextResponse.json({ error: sheetErrorMessage(e) }, { status: 500 })
  }

  // One fixed game for the whole request (old callers), or per offer from its category.
  let fixed: GameProfile | null = null
  if (body.game?.gameId && body.game.gameSlug) {
    try {
      fixed = await profileFor({ id: body.game.gameId, slug: body.game.gameSlug, name: body.game.gameName || body.game.gameSlug })
    } catch (e) {
      return errorResponse(e, "POST /api/ai/prepare: loading game fields")
    }
  }
  const picks: Record<string, GameRef> = {}
  for (const [k, v] of Object.entries(body.picks || {})) if (/^\d+$/.test(k) && isGameRef(v)) picks[k] = { id: v.id, slug: v.slug, name: v.name }
  const store = getStateStore()
  const profiles = new Map<number, Promise<GameProfile>>()

  const results = await prepareBatch(
    items.map(it => ({ link: it.link!.trim(), price: (it.price || "").trim(), seller: (it.seller || "").trim() })),
    {
      readOffer: readSourceOffer,
      ai,
      game: fixed,
      gameFor: fixed
        ? undefined
        : async src => {
            const g = await resolveGame(src, {
              store,
              picks,
              searchGames: async q => (await listGames(q)).map(x => ({ id: x.id, name: x.name, slug: x.slug })),
            })
            if (!g) return null
            if (!profiles.has(g.id)) profiles.set(g.id, profileFor(g))
            return profiles.get(g.id)!
          },
      defaultDescription: body.defaultDescription,
      listed: id => ids.get(id) ?? null,
    }
  )
  return NextResponse.json({ results, aiUsage: ai.usage() })
}
