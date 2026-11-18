import { canonicalIdOf } from "../sources/index"
import { prepareOffer, type PrepareDeps, type PrepareInput, type PreparedOffer } from "../pipeline/prepare"

/** Items per /api/ai/prepare call. With one page every 1.5 s plus AI time this fits the function time limit. */
export const PREPARE_MAX_ITEMS = 6
/** Minimum gap between two source-page reads (FunPay rule: about 1 request per 1.5 s). */
export const SOURCE_GAP_MS = 1500

export type BatchDeps = Omit<PrepareDeps, "isDuplicate"> & {
  /** Already listed? (sheet lookup by lot id) */
  listed: (canonicalId: string) => string | null
  sleep?: (ms: number) => Promise<void>
  gapMs?: number
}

/**
 * Prepare offers ONE AT A TIME (never in parallel), waiting `gapMs` before every source read after the first.
 * Duplicates (in the sheet or repeated in this batch) are stopped before any read, so they cost no wait.
 */
export async function prepareBatch(items: PrepareInput[], deps: BatchDeps): Promise<PreparedOffer[]> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const gap = deps.gapMs ?? SOURCE_GAP_MS
  const seen = new Set<string>()
  const out: PreparedOffer[] = []
  let reads = 0
  for (const it of items) {
    const id = canonicalIdOf(it.link)
    const dup = id ? (seen.has(id) ? "repeated in this batch" : deps.listed(id)) : null
    if (id) seen.add(id)
    const willRead = !!id && !dup
    if (willRead && reads++ > 0) await sleep(gap)
    out.push(await prepareOffer(it, { ...deps, isDuplicate: () => dup }))
  }
  return out
}
