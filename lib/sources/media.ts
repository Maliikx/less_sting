/**
 * Images from screenshot albums that sellers link in the description instead of uploading to FunPay
 * (about 1 in 3 offers). Decided with the user: flag these offers AND try to read the album.
 *
 *  - postimg.cc  gallery / image page -> direct https://i.postimg.cc/... links (GameBoost takes image URLs)
 *  - imgur.com   album / image page   -> direct https://i.imgur.com/... links, but GameBoost does NOT accept imgur,
 *                                        so they are returned as `unusable` until they are re-hosted (open question)
 *  - anything else (YouTube, profile sites) -> not an image source; reported only
 *
 * Checked on the Vercel preview (2026-11-18): a real postimg gallery gave 10 images, a real imgur album 2 (unusable).
 * The tests still use synthetic album pages (this dev container cannot reach these hosts). Extraction is strict
 * (only direct image-host links) so a layout change finds nothing rather than something wrong.
 */
import type { FetchedPage } from "./types"

export type MediaKind = "postimg" | "imgur" | "video" | "other"

export type AlbumResult = {
  link: string
  kind: MediaKind
  status: "ok" | "empty" | "error" | "skipped"
  /** Direct image links GameBoost can take. */
  images: string[]
  /** Direct image links found but not accepted by GameBoost (imgur). */
  unusable: string[]
  note?: string
}

/** Albums read per offer, at most. Each is one request to a different site than FunPay. */
export const MAX_ALBUMS_PER_OFFER = 2
const MAX_IMAGES = 10

export function classifyMedia(raw: string): MediaKind {
  let host = ""
  try {
    host = new URL(raw).hostname.toLowerCase()
  } catch {
    return "other"
  }
  if (/(^|\.)(postimg\.cc|postimages\.org)$/.test(host)) return "postimg"
  if (/(^|\.)imgur\.com$/.test(host)) return "imgur"
  if (/(^|\.)(youtube\.com|youtu\.be|vimeo\.com)$/.test(host)) return "video"
  return "other"
}

const IMAGE_PATH = /\.(?:jpe?g|png|webp)$/i

/** Direct image links on an album page. Only the album host's own image CDN counts; site logos/avatars are skipped. */
export function imagesFromAlbumPage(kind: MediaKind, html: string): string[] {
  const text = html.replace(/\\\//g, "/").replace(/&amp;/g, "&")
  const re =
    kind === "postimg"
      ? /https:\/\/i\.postimg\.cc\/[A-Za-z0-9]+\/[^\s"'<>()\\?#]+/g
      : kind === "imgur"
        ? /https?:\/\/i\.imgur\.com\/[A-Za-z0-9]{5,10}\.(?:jpe?g|png|webp)/g
        : null
  if (!re) return []
  const out: string[] = []
  for (const m of text.matchAll(re)) {
    let u = m[0].replace(/^http:/, "https:")
    try {
      u = new URL(u).href
    } catch {
      continue
    }
    if (!IMAGE_PATH.test(new URL(u).pathname)) continue
    if (/logo|avatar|favicon|icon|sprite/i.test(u)) continue
    if (!out.includes(u)) out.push(u)
    if (out.length >= MAX_IMAGES) break
  }
  return out
}

export type AlbumDeps = {
  fetcher: (url: string) => Promise<FetchedPage>
  sleep?: (ms: number) => Promise<void>
  /** Gap between two album requests. */
  gapMs?: number
}

/** Read up to MAX_ALBUMS_PER_OFFER album links. Never throws. Stops once usable images are found. */
export async function readAlbums(links: string[], deps: AlbumDeps): Promise<AlbumResult[]> {
  const sleep = deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const out: AlbumResult[] = []
  let fetched = 0
  for (const link of links) {
    const kind = classifyMedia(link)
    if (kind !== "postimg" && kind !== "imgur") {
      out.push({ link, kind, status: "skipped", images: [], unusable: [], note: kind === "video" ? "video, not images" : "not an image album" })
      continue
    }
    if (fetched >= MAX_ALBUMS_PER_OFFER || out.some(r => r.images.length)) {
      out.push({ link, kind, status: "skipped", images: [], unusable: [], note: "enough albums read" })
      continue
    }
    if (fetched++ > 0) await sleep(deps.gapMs ?? 1500)
    try {
      const page = await deps.fetcher(link)
      if (page.status >= 400) {
        out.push({ link, kind, status: "error", images: [], unusable: [], note: `HTTP ${page.status}` })
        continue
      }
      const found = imagesFromAlbumPage(kind, page.html)
      const usable = kind === "imgur" ? [] : found
      const unusable = kind === "imgur" ? found : []
      out.push({
        link,
        kind,
        status: found.length ? "ok" : "empty",
        images: usable,
        unusable,
        note: !found.length ? "no images found on the album page" : kind === "imgur" ? "GameBoost does not accept imgur images" : undefined,
      })
    } catch (e) {
      out.push({ link, kind, status: "error", images: [], unusable: [], note: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}
