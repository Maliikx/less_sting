import { getTemplate } from "./gameboost"
import { specsFromTemplate, type FieldSpec } from "./gameFields"
import { probeRequired } from "./probeRequired"
import { extractAccountData, requiredFromTemplate } from "./template"

/**
 * Field specs for one game (what to fill, which are required), cached in memory for a few hours.
 * Required fields come from the template when it says so, plus the failing-create probe.
 */
type Cached = { at: number; specs: FieldSpec[]; gameName?: string; gameId: number }
const cache = new Map<string, Cached>()
const TTL = 6 * 3600_000

export async function loadGameProfile(game: { gameId: number; gameSlug: string; gameName?: string }): Promise<Cached> {
  const key = String(game.gameId)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit

  const raw = await getTemplate(game.gameSlug)
  const accountData = extractAccountData(raw)
  const required = new Set(requiredFromTemplate(accountData))
  try {
    const probed = await probeRequired(game.gameId)
    probed.requiredFields.forEach(f => required.add(f))
  } catch (e) {
    console.error("loadGameProfile probe failed:", e instanceof Error ? e.message : e)
  }
  const specs = specsFromTemplate(accountData, [...required])
  const entry = { at: Date.now(), specs, gameName: game.gameName, gameId: game.gameId }
  cache.set(key, entry)
  return entry
}
