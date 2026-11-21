import { fetchPage } from "../sourcePage"
import { funpay } from "./funpay"
import { readAlbums } from "./media"
import type { FetchedPage, SourceAdapter, SourceOffer } from "./types"

export * from "./types"

/** Register new source sites here (Eldorado, ...). One adapter per site. */
const ADAPTERS: SourceAdapter[] = [funpay]

export function adapterFor(raw: string): { adapter: SourceAdapter; url: URL } | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  const adapter = ADAPTERS.find(a => a.matches(url))
  return adapter ? { adapter, url } : null
}

/** Duplicate key for any link we support; null for unsupported/malformed links. */
export function canonicalIdOf(raw: string): string | null {
  const a = adapterFor(raw)
  return a ? a.adapter.canonicalId(a.url) : null
}

export type PageFetcher = (url: string) => Promise<FetchedPage>

/**
 * Fetch + parse one offer and also hand back the raw HTML (for the /probe page download).
 * Never throws: network problems come back as status "error". `fetcher` is injectable for tests.
 */
export async function readSourceOfferWithPage(raw: string, fetcher: PageFetcher = fetchPage): Promise<{ offer: SourceOffer; html?: string }> {
  const a = adapterFor(raw)
  if (!a) {
    return { offer: { source: "unknown", canonicalId: "", url: raw, status: "error", message: "Unsupported or invalid link", params: {}, images: [], warnings: [] } }
  }
  const id = a.adapter.canonicalId(a.url)
  if (!id) {
    return { offer: { source: a.adapter.id, canonicalId: "", url: raw, status: "error", message: "Not a single-offer link", params: {}, images: [], warnings: [] } }
  }
  try {
    const page = await fetcher(a.adapter.canonicalUrl(a.url))
    const offer = a.adapter.parse(page)
    await addAlbumImages(offer, fetcher)
    return { offer, html: page.html }
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "TimeoutError" ? "The page took too long to open" : e.message) : String(e)
    return { offer: { source: a.adapter.id, canonicalId: id, url: raw, status: "error", message: msg, params: {}, images: [], warnings: [] } }
  }
}

/** Fetch + parse one offer. Never throws: network problems come back as status "error". */
export async function readSourceOffer(raw: string, fetcher: PageFetcher = fetchPage): Promise<SourceOffer> {
  return (await readSourceOfferWithPage(raw, fetcher)).offer
}

/**
 * No images on the source page but the description links an album: try to read it (decided with the user).
 * The offer stays flagged either way (warning), so a human checks the pictures belong to this account.
 */
export async function addAlbumImages(offer: SourceOffer, fetcher: PageFetcher): Promise<void> {
  if (offer.status !== "ok" || offer.images.length || !offer.externalMedia?.length) return
  const results = await readAlbums(offer.externalMedia, { fetcher })
  offer.albums = results.map(r => ({ link: r.link, kind: r.kind, status: r.status, images: r.images.length, unusable: r.unusable.length, note: r.note }))
  const hit = results.find(r => r.images.length)
  if (hit) {
    offer.images = hit.images
    offer.imagesFrom = hit.link
    offer.warnings.push(`images taken from the linked album ${hit.link}; check they show this account`)
    return
  }
  const imgur = results.find(r => r.unusable.length)
  if (imgur) offer.warnings.push(`the imgur album has ${imgur.unusable.length} image(s), but GameBoost does not accept imgur; add images by hand`)
  else if (results.some(r => r.status === "error")) offer.warnings.push("could not read the linked album")
}
