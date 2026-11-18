/**
 * Source adapters read ONE offer page on a marketplace we copy offers from (FunPay now, others later).
 * Everything downstream (cleaning, AI, publishing) only sees SourceOffer, so adding a site
 * means adding one adapter file and registering it in ./index.ts.
 */

/** ok = page read; not_found = we are SURE the offer is gone; blocked/error = unknown (never treat as dead). */
export type SourceStatus = "ok" | "not_found" | "blocked" | "error"

export type SourceOffer = {
  source: string
  /** Stable id for duplicate checks, e.g. "funpay:71122224". Works on old sheet rows too (they hold the link). */
  canonicalId: string
  url: string
  status: SourceStatus
  httpStatus?: number
  message?: string

  /** FunPay "Short description" (this is what we use as the title). */
  title?: string
  description?: string
  /** All other label/value pairs on the page (Server, Rank, ...). Cheap, reliable input for game fields. */
  params: Record<string, string>
  category?: string
  game?: string

  images: string[]
  /** Price exactly as on the page, no currency conversion (project rule). */
  price?: number
  priceText?: string
  currency?: string

  /** What the parser could and could not find. Shown in the review screen and the probe report. */
  warnings: string[]
}

export type FetchedPage = { status: number; html: string; finalUrl: URL }

export interface SourceAdapter {
  id: string
  matches(url: URL): boolean
  /** null when the link is not a single-offer link of this site. */
  canonicalId(url: URL): string | null
  /** Link normalised to the English page, so parsing sees one language layout. */
  canonicalUrl(url: URL): string
  /** Pure: HTML in, offer out. Fully testable with saved pages. */
  parse(page: FetchedPage): SourceOffer
}
