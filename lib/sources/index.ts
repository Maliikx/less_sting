import { fetchPage } from "../sourcePage"
import { funpay } from "./funpay"
import type { SourceAdapter, SourceOffer } from "./types"

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

/** Fetch + parse one offer. Never throws: network problems come back as status "error". */
export async function readSourceOffer(raw: string): Promise<SourceOffer> {
  const a = adapterFor(raw)
  if (!a) {
    return { source: "unknown", canonicalId: "", url: raw, status: "error", message: "Unsupported or invalid link", params: {}, images: [], warnings: [] }
  }
  const id = a.adapter.canonicalId(a.url)
  if (!id) {
    return { source: a.adapter.id, canonicalId: "", url: raw, status: "error", message: "Not a single-offer link", params: {}, images: [], warnings: [] }
  }
  try {
    const page = await fetchPage(a.adapter.canonicalUrl(a.url))
    return a.adapter.parse(page)
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "TimeoutError" ? "The page took too long to open" : e.message) : String(e)
    return { source: a.adapter.id, canonicalId: id, url: raw, status: "error", message: msg, params: {}, images: [], warnings: [] }
  }
}
