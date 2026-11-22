import { applyLearnedTypes, normalizeSpecs, type FieldSpec } from "../gameFields"
import type { StateStore } from "../state/store"

/** Game field specs are cached in LS_STATE (shared by all serverless instances) for 24 h. */
export const PROFILE_TTL_MS = 24 * 3600_000
export const profileKey = (gameId: number) => `gameprofile:v2:${gameId}` // v2: list fields merged (normalizeSpecs)

export async function readCachedSpecs(store: StateStore, gameId: number): Promise<FieldSpec[] | null> {
  const hit = await store.get<FieldSpec[]>(profileKey(gameId)).catch(() => null)
  return hit && Array.isArray(hit.value) ? normalizeSpecs(hit.value) : null
}

export async function writeCachedSpecs(store: StateStore, gameId: number, specs: FieldSpec[]) {
  await store.set(profileKey(gameId), specs, { ttlMs: PROFILE_TTL_MS }).catch(() => {})
}

/** A publish taught us field types (GameBoost 422): fix the cached specs so the next batch gets them right. */
export async function rememberLearnedTypes(store: StateStore, gameId: number, types: Record<string, string>) {
  const specs = await readCachedSpecs(store, gameId)
  if (!specs) return false
  const r = applyLearnedTypes(specs, types)
  if (r.changed) await writeCachedSpecs(store, gameId, r.specs)
  return r.changed
}
