import { extractImages, extractPrice, notFoundPhrases, pageText } from "../sourcePage"
import type { FetchedPage, SourceAdapter, SourceOffer } from "./types"

/**
 * FunPay single-offer page: https://funpay.com/en/lots/offer?id=<number>
 *
 * IMPORTANT: written from FunPay's usual layout (blocks with an <h5> label followed by the value),
 * NOT yet checked against live pages. The parser is label-driven and tolerant on purpose, and every
 * thing it cannot find ends up in `warnings`. Run `npm run probe:funpay -- links.txt` on real links
 * and fix the labels below if the report shows misses.
 */

const LABELS = {
  short: ["short description", "краткое описание"],
  detailed: ["detailed description", "подробное описание", "полное описание"],
  category: ["category", "категория"],
  game: ["game", "игра"],
}

const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")

/** HTML fragment -> plain text, keeping line breaks from <br> and block tags. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** All "<h5>Label</h5> value..." blocks. Value ends at the next <h5> or the end of the parent block. */
export function extractLabelledBlocks(html: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /<h[3-6]\b[^>]*>([\s\S]*?)<\/h[3-6]>/gi
  const heads: { label: string; start: number; end: number }[] = []
  for (const m of html.matchAll(re)) {
    const label = htmlToText(m[1]).replace(/[:：]\s*$/, "").trim()
    if (label && label.length <= 60) heads.push({ label, start: m.index!, end: m.index! + m[0].length })
  }
  heads.forEach((h, i) => {
    const stop = heads[i + 1]?.start ?? Math.min(html.length, h.end + 6000)
    let chunk = html.slice(h.end, stop)
    // stop at the end of this param block (a closing </div> that closes the block holding the <h5>)
    const open = html.slice(0, h.start).lastIndexOf("<div")
    if (open >= 0) {
      let depth = 1
      const tag = /<(\/?)div\b[^>]*>/gi
      tag.lastIndex = 0
      let cut = -1
      for (const t of chunk.matchAll(tag)) {
        depth += t[1] ? -1 : 1
        if (depth === 0) { cut = t.index!; break }
      }
      if (cut >= 0) chunk = chunk.slice(0, cut)
    }
    const value = htmlToText(chunk)
    if (value && !(h.label.toLowerCase() in out)) out[h.label] = value
  })
  return out
}

const pick = (blocks: Record<string, string>, names: string[]) => {
  for (const [k, v] of Object.entries(blocks)) if (names.includes(k.toLowerCase())) return v
  return undefined
}

function currencyOf(text?: string) {
  if (!text) return undefined
  if (/€|\beur\b/i.test(text)) return "EUR"
  if (/\$|\busd\b/i.test(text)) return "USD"
  if (/₽|\brub\b|руб/i.test(text)) return "RUB"
  if (/£|\bgbp\b/i.test(text)) return "GBP"
  if (/₴|\buah\b/i.test(text)) return "UAH"
  return undefined
}

function metaContent(html: string, prop: string) {
  const m = html.match(new RegExp(`<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${prop}["'][^>]*>`, "i"))
  const c = m?.[0].match(/content\s*=\s*["']([^"']*)["']/i)
  return c ? decodeEntities(c[1]).trim() : undefined
}

export const funpay: SourceAdapter = {
  id: "funpay",

  matches(url) {
    return /(^|\.)funpay\.com$/i.test(url.hostname)
  },

  canonicalId(url) {
    if (!/\/lots\/offer\/?$/i.test(url.pathname)) return null
    const id = url.searchParams.get("id")
    return id && /^\d{3,}$/.test(id) ? `funpay:${id}` : null
  },

  canonicalUrl(url) {
    const id = url.searchParams.get("id")
    return `https://funpay.com/en/lots/offer?id=${id}`
  },

  parse({ status, html, finalUrl }: FetchedPage): SourceOffer {
    const id = this.canonicalId(finalUrl) || this.canonicalId(new URL(finalUrl.href)) || `funpay:${finalUrl.searchParams.get("id") ?? "?"}`
    const base: SourceOffer = {
      source: "funpay",
      canonicalId: id,
      url: finalUrl.href,
      status: "ok",
      httpStatus: status,
      params: {},
      images: [],
      warnings: [],
    }

    const text = pageText(html)
    if (status === 404 || status === 410 || notFoundPhrases().some(p => text.includes(p))) {
      return { ...base, status: "not_found", message: "Offer not found at this link" }
    }
    if (status === 403 || status === 429 || status === 503 || /just a moment|cf-chl|captcha/i.test(html.slice(0, 20000))) {
      return { ...base, status: "blocked", message: `The site blocked the check (HTTP ${status})` }
    }
    if (status >= 400) return { ...base, status: "error", message: `The page returned HTTP ${status}` }

    const blocks = extractLabelledBlocks(html)
    const warnings: string[] = []

    let title = pick(blocks, LABELS.short)
    if (!title) {
      title = metaContent(html, "og:title")?.replace(/\s*[|\-–]\s*FunPay.*$/i, "").trim()
      warnings.push(title ? "no 'Short description' block; title taken from og:title" : "title not found")
    }
    const description = pick(blocks, LABELS.detailed)
    if (!description) warnings.push("no 'Detailed description' block")

    const params: Record<string, string> = {}
    for (const [k, v] of Object.entries(blocks)) {
      const lk = k.toLowerCase()
      if ([...LABELS.short, ...LABELS.detailed].includes(lk)) continue
      if (v.length <= 200) params[k] = v
    }
    const category = pick(blocks, LABELS.category)
    const game = pick(blocks, LABELS.game)

    const images = extractImages(html, finalUrl)
    if (!images.length) warnings.push("no images found")

    const p = extractPrice(html)
    if (!p) warnings.push("price not found")

    return {
      ...base,
      title,
      description,
      params,
      category,
      game,
      images,
      price: p?.price,
      priceText: p?.priceText,
      currency: currencyOf(p?.priceText),
      warnings,
    }
  },
}
