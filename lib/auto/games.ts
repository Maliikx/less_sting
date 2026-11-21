import type { StateStore } from "../state/store"

/**
 * FunPay category -> GameBoost game.
 *  1. the user's pick in this request (then remembered)
 *  2. a remembered pick/match (StateStore key `gamemap:<source>:<categoryId>`, shared by all instances)
 *  3. exactly ONE GameBoost game whose name equals the category's game name (ignoring case/punctuation), then remembered
 *  otherwise null -> the offer is flagged and the user picks once. Never a fuzzy guess.
 */

export type GameRef = { id: number; slug: string; name: string }

const norm = (s: string) =>
  s.toLowerCase().replace(/&/g, " and ").replace(/[’'`]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim()

export function matchGame(name: string | undefined, games: GameRef[]): GameRef | null {
  if (!name) return null
  const n = norm(name)
  const hits = games.filter(g => norm(g.name) === n)
  return hits.length === 1 ? hits[0] : null
}

export const gameKey = (source: string, categoryId: string) => `gamemap:${source}:${categoryId}`

export function isGameRef(x: unknown): x is GameRef {
  const g = x as GameRef
  return !!g && typeof g.id === "number" && g.id > 0 && typeof g.slug === "string" && !!g.slug && typeof g.name === "string"
}

export type ResolveDeps = {
  store: StateStore
  searchGames: (search: string) => Promise<GameRef[]>
  /** categoryId -> game the user picked for this batch */
  picks?: Record<string, GameRef>
}

export async function resolveGame(src: { source: string; categoryId?: string; game?: string }, deps: ResolveDeps): Promise<GameRef | null> {
  if (!src.categoryId) return null
  const key = gameKey(src.source, src.categoryId)
  const pick = deps.picks?.[src.categoryId]
  if (pick && isGameRef(pick)) {
    await deps.store.set(key, { ...pick, by: "user" })
    return pick
  }
  const saved = (await deps.store.get<GameRef & { by?: string }>(key))?.value
  if (isGameRef(saved)) return { id: saved.id, slug: saved.slug, name: saved.name }
  if (!src.game) return null
  const match = matchGame(src.game, await deps.searchGames(src.game))
  if (match) await deps.store.set(key, { ...match, by: "auto" })
  return match
}
