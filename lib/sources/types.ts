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
  /** FunPay category name from the page's back link, e.g. "PUBG Mobile Accounts". */
  category?: string
  /** FunPay category id (the number in /lots/<id>/). Stable key for game mapping (plan step 7). */
  categoryId?: string
  /** Game guessed from the category name ("PUBG Mobile"). */
  game?: string

  /** The source seller's username (removed from the text with its sentence). */
  sellerName?: string
  /** Full-size images uploaded to the offer page. */
  images: string[]
  /** Screenshot albums / videos the description links to (imgur, postimg, YouTube...). postimg/imgur albums are read when the offer has no FunPay images. */
  externalMedia?: string[]
  /** When `images` came from a linked album instead of FunPay: that album's link. Needs a human look. */
  imagesFrom?: string
  /** What happened with each linked album (see lib/sources/media.ts). */
  albums?: { link: string; kind: string; status: string; images: number; unusable: number; note?: string }[]
  /** Price exactly as on the page, no currency conversion (project rule). */
  price?: number
  priceText?: string
  currency?: string
  /** The seller's own price before FunPay's payment fee (data-factors), same currency. Information only for now. */
  sellerPrice?: number
  /** Every payment option on the page (method, currency, buyer price). For review/debugging. */
  priceOptions?: PriceOption[]

  /** What the parser could and could not find. Shown in the review screen and the probe report. */
  warnings: string[]
}

export type PriceOption = { method: string; currency: string; price: number; priceText: string; sellerPrice?: number }

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
