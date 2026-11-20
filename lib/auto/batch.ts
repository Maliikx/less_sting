import { titleKey } from "../text"
import { prepareOffer, type PrepareDeps, type PrepareInput, type PreparedOffer } from "../pipeline/prepare"

/** Items per /api/ai/prepare call. */
export const PREPARE_MAX_ITEMS = 8
/** Minimum gap between the START of two source-page reads (FunPay rule: about 1 request per 1.5 s). */
export const SOURCE_GAP_MS = 1500
/** Offers worked on at the same time (AI calls overlap with the next page read; page reads stay 1.5 s apart). */
export const PREPARE_CONCURRENCY = 3

export type BatchDeps = Omit<PrepareDeps, "isDuplicate" | "isDuplicateTitle"> & {
  /** Already in the sheet? Looked up by `titleKey(title)`. Return where (e.g. "sheet row 12: ..."), or null. */
  listedTitle: (normalizedTitle: string) => string | null
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  gapMs?: number
  concurrency?: number
}

/**
 * Rate gate: each call starts at least `gap` ms after the previous call STARTED, however many callers there are.
 * (Starts are what the source site sees; overlapping a slow AI call with the next read is fine.)
 */
export function startGate(gap: number, sleep: (ms: number) => Promise<void>, now: () => number) {
  let nextAt = -Infinity
  return async () => {
    const t = now()
    const startAt = Math.max(t, nextAt)
    nextAt = startAt + gap
    if (startAt > t) await sleep(startAt - t)
    return startAt
  }
}

/**
 * Prepare a batch: duplicates by TITLE only (sheet + earlier in this batch; user decision, so the same link twice is
 * read twice and caught by its title), page reads start >= 1.5 s apart, up to 3 offers in flight. Results keep the input order.
 */
export async function prepareBatch(items: PrepareInput[], deps: BatchDeps): Promise<PreparedOffer[]> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const gate = startGate(deps.gapMs ?? SOURCE_GAP_MS, sleep, deps.now ?? Date.now)
  const readOffer: PrepareDeps["readOffer"] = async link => {
    await gate()
    return deps.readOffer(link)
  }

  // Titles listed earlier in THIS batch (first come, first served).
  const batchTitles = new Map<string, number>()
  const listedTitle = (titles: { original: string; cleaned: string }, index: number) => {
    const keys = [...new Set([titleKey(titles.original), titleKey(titles.cleaned)].filter(Boolean))]
    for (const k of keys) {
      const hit = deps.listedTitle(k)
      if (hit) return hit
      const other = batchTitles.get(k)
      if (other !== undefined && other !== index) return `same title as line ${other + 1} of this batch`
    }
    for (const k of keys) if (!batchTitles.has(k)) batchTitles.set(k, index)
    return null
  }

  const out: PreparedOffer[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(deps.concurrency ?? PREPARE_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await prepareOffer(items[i], {
        ...deps,
        readOffer,
        isDuplicateTitle: t => listedTitle(t, i),
      })
    }
  })
  await Promise.all(workers)
  return out
}
