/**
 * Probe: read real source pages from the server that will run in production (Vercel),
 * to check how the parser does and whether the site blocks us. Read-only: no sheet, no GameBoost, no AI.
 *
 * Pure and injectable (fetcher, sleep) so it is tested offline.
 */
import { canonicalIdOf, readSourceOfferWithPage, type PageFetcher } from "./index"
import type { SourceStatus } from "./types"

/** Links per request. Kept small so a chunk (5 x 1.5 s + page time) fits well inside the function time limit. */
export const PROBE_MAX_LINKS = 5
/** Minimum gap between two requests to the source site. Do not lower this (project rule, FunPay robots.txt). */
export const PROBE_GAP_MS = 1500

export type ProbeRow = {
  link: string
  lotId: string
  status: SourceStatus
  httpStatus?: number
  title: string
  descriptionChars: number
  images: number
  /** Album the images came from, when the offer page had none. */
  imagesFrom?: string
  /** One line per linked album: "postimg ok 6", "imgur ok 0 (+4 unusable)", ... */
  albums?: string[]
  priceText?: string
  currency?: string
  params: string[]
  category?: string
  game?: string
  warnings: string[]
  message?: string
  /** Raw page, only when asked for (for the "download HTML" button). */
  html?: string
}

export type ProbeDeps = {
  fetcher?: PageFetcher
  sleep?: (ms: number) => Promise<void>
  gapMs?: number
  includeHtml?: boolean
}

/** Trim, drop empties, and keep the first link per lot id (unsupported links are kept once each, so they get reported). */
export function dedupeLinks(lines: string[]): { links: string[]; repeated: string[] } {
  const seen = new Set<string>()
  const links: string[] = []
  const repeated: string[] = []
  for (const raw of lines) {
    const l = raw.trim()
    if (!l) continue
    const key = canonicalIdOf(l) || `raw:${l}`
    if (seen.has(key)) {
      repeated.push(l)
      continue
    }
    seen.add(key)
    links.push(l)
  }
  return { links, repeated }
}

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Read links one by one, waiting `gapMs` BEFORE every network request except the first in this call.
 * The caller (browser) waits `gapMs` between calls, so the site never sees more than ~1 request per gap.
 * Never throws; every link gets a row.
 */
export async function probeLinks(links: string[], deps: ProbeDeps = {}): Promise<ProbeRow[]> {
  const sleep = deps.sleep ?? realSleep
  const gap = deps.gapMs ?? PROBE_GAP_MS
  const rows: ProbeRow[] = []
  let fetched = 0
  for (const link of links) {
    const lotId = canonicalIdOf(link) || ""
    // Unsupported links never reach the network, so they cost no wait.
    if (lotId && fetched++ > 0) await sleep(gap)
    const { offer, html } = await readSourceOfferWithPage(link, deps.fetcher)
    rows.push({
      link,
      lotId: offer.canonicalId || lotId,
      status: offer.status,
      httpStatus: offer.httpStatus,
      title: offer.title || "",
      descriptionChars: (offer.description || "").length,
      images: offer.images.length,
      imagesFrom: offer.imagesFrom,
      albums: offer.albums?.map(a => `${a.kind} ${a.status} ${a.images}${a.unusable ? ` (+${a.unusable} unusable)` : ""}${a.note ? `: ${a.note}` : ""}`),
      priceText: offer.priceText,
      currency: offer.currency,
      params: Object.keys(offer.params),
      category: offer.category,
      game: offer.game,
      warnings: offer.warnings,
      message: offer.message,
      ...(deps.includeHtml && html !== undefined ? { html } : {}),
    })
  }
  return rows
}

export type ProbeSummary = {
  total: number
  byStatus: Record<SourceStatus, number>
  /** Counts among `ok` pages. */
  found: { title: number; description: number; images: number; price: number; params: number }
  /** Percent of `ok` pages (0 when there are none). */
  hitRates: { title: number; description: number; images: number; price: number; params: number }
  /** Share of all rows that were blocked (403/429/captcha). High = stop and discuss plan B/C. */
  blockedShare: number
}

export function summarize(rows: ProbeRow[]): ProbeSummary {
  const byStatus: Record<SourceStatus, number> = { ok: 0, not_found: 0, blocked: 0, error: 0 }
  const found = { title: 0, description: 0, images: 0, price: 0, params: 0 }
  for (const r of rows) {
    byStatus[r.status]++
    if (r.status !== "ok") continue
    if (r.title) found.title++
    if (r.descriptionChars > 0) found.description++
    if (r.images > 0) found.images++
    if (r.priceText) found.price++
    if (r.params.length) found.params++
  }
  const pct = (n: number) => (byStatus.ok ? Math.round((100 * n) / byStatus.ok) : 0)
  return {
    total: rows.length,
    byStatus,
    found,
    hitRates: { title: pct(found.title), description: pct(found.description), images: pct(found.images), price: pct(found.price), params: pct(found.params) },
    blockedShare: rows.length ? byStatus.blocked / rows.length : 0,
  }
}

/** Validate the request body of POST /api/source/probe. Returns an error message or the parsed input. */
export function parseProbeRequest(body: unknown): { error: string } | { links: string[]; includeHtml: boolean } {
  if (!body || typeof body !== "object") return { error: "Send JSON: { links: string[], includeHtml?: boolean }" }
  const b = body as { links?: unknown; includeHtml?: unknown }
  if (!Array.isArray(b.links) || !b.links.every(l => typeof l === "string")) return { error: "links must be an array of strings" }
  const links = b.links.map(l => (l as string).trim()).filter(Boolean)
  if (!links.length) return { error: "No links" }
  if (links.length > PROBE_MAX_LINKS) return { error: `At most ${PROBE_MAX_LINKS} links per request` }
  if (links.some(l => l.length > 2000)) return { error: "Link too long" }
  return { links, includeHtml: b.includeHtml === true }
}
