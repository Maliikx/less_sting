import { extractPrice, notFoundPhrases } from "../sourcePage"
import type { FetchedPage, PriceOption, SourceAdapter, SourceOffer } from "./types"

/**
 * FunPay single-offer page: https://funpay.com/en/lots/offer?id=<number>
 *
 * Checked against real pages (tests/fixtures/real, saved 2026-11-18). Layout:
 *  - <div class="back-link"><a href=".../lots/<categoryId>/"><span class="inside">PUBG Mobile Accounts</span></a>
 *  - <div class="param-list"> with <div class="param-item"><h5>Label</h5><div class="text-bold">Value</div></div>
 *    for the game parameters, then "Short description", "Detailed description" and "Images" param-items
 *  - Images: <ul class="attachments-list"><a class="attachments-thumb" style="background-image:url(<thumb>)" href="<full size>">
 *  - Price: buy form <select name="method"> options with data-cy (currency), data-factors (seller price, fee factor)
 *    and data-content holding <span class="payment-value">180.64 $</span>. The set of currencies depends on the visitor.
 *  - Dead offer: HTTP 404 with <h1 class="page-header">Offer not found</h1>
 *  - /en/ pages show FunPay's own English translation of Russian offers.
 *
 * The purchase form also has param-items ("Your account will be charged for", "Remaining price"); they are NOT
 * offer parameters and are outside the param-list, so they are ignored.
 */

const LABELS = {
  short: ["short description", "краткое описание"],
  detailed: ["detailed description", "подробное описание", "полное описание"],
  /** param-list items that are not game parameters */
  notParams: ["images", "картинки", "in stock", "наличие", "seller's rating", "рейтинг продавца"],
}

/** Hosts sellers use for screenshot albums / videos when they don't upload images to FunPay (albums are read in ./media.ts). */
const MEDIA_HOSTS = /\b(?:postimg\.cc|postimages\.org|imgur\.com|prnt\.sc|prntscr\.com|gyazo\.com|ibb\.co|imgbb\.com|youtu\.be|youtube\.com|drive\.google\.com|disk\.yandex\.\w+|yadi\.sk|tracker\.gg|r6skins\.locker|lightshot)\b/i
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

/** Text between two markers (start inclusive); empty when the start marker is missing. */
function section(html: string, start: RegExp, end: RegExp) {
  const s = html.search(start)
  if (s < 0) return ""
  const rest = html.slice(s)
  const e = rest.slice(1).search(end)
  return e < 0 ? rest : rest.slice(0, e + 1)
}

/** "PUBG Mobile Accounts" -> "PUBG Mobile"; "Аккаунты PUBG Mobile" -> "PUBG Mobile". */
export function gameFromCategory(category?: string) {
  if (!category) return undefined
  const g = category.replace(/\s+(accounts?|account)$/i, "").replace(/^accounts?\s+(?:for|of)\s+/i, "").replace(/^аккаунты\s+/i, "").trim()
  return g && g !== category ? g : undefined
}

/** Category name and id from the "back" link at the top of the offer. */
export function extractCategory(html: string): { category?: string; categoryId?: string } {
  const m = html.match(/<div class="back-link">\s*<a\b[^>]*href="[^"]*\/lots\/(\d+)\/?"[^>]*>[\s\S]*?<span class="inside">([\s\S]*?)<\/span>/i)
  if (!m) return {}
  return { categoryId: m[1], category: htmlToText(m[2]) || undefined }
}

/** Full-size gallery images (the link target, not the background-image thumbnail). */
export function extractGallery(html: string, base: URL): string[] {
  const list = section(html, /<ul class="attachments-list"/i, /<\/ul>/i)
  const out: string[] = []
  for (const m of list.matchAll(/<a\b[^>]*class="[^"]*\battachments-thumb\b[^"]*"[^>]*>/gi)) {
    const href = m[0].match(/\bhref\s*=\s*"([^"]+)"/i)?.[1]
    if (!href) continue
    try {
      const u = new URL(decodeEntities(href), base)
      if ((u.protocol === "https:" || u.protocol === "http:") && !out.includes(u.href)) out.push(u.href)
    } catch {
      /* skip bad link */
    }
  }
  return out
}

/** Links in the description that point at screenshot albums or videos (parse stays pure: nothing is fetched here). */
export function externalMediaLinks(text?: string): string[] {
  if (!text) return []
  const out: string[] = []
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')]+/gi)) if (MEDIA_HOSTS.test(m[0]) && !out.includes(m[0])) out.push(m[0])
  return out
}

/** Every payment option of the buy form: currency, price the buyer pays, and the seller's own price (data-factors[0]). */
export function extractPriceOptions(html: string): PriceOption[] {
  const out: PriceOption[] = []
  for (const m of html.matchAll(/<option\b([^>]*)>/gi)) {
    const a = m[1]
    const cy = a.match(/\bdata-cy="(\w+)"/i)?.[1]
    const content = a.match(/\bdata-content="([^"]*)"/i)?.[1]
    if (!cy || !content) continue
    const inner = decodeEntities(decodeEntities(content))
    const pv = inner.match(/class="payment-value">([^<]*)</i)?.[1]?.replace(/\s+/g, " ").trim()
    const title = inner.match(/class="payment-title">([^<]*)</i)?.[1]?.trim()
    const amount = pv ? Number(pv.replace(/[^\d.,]/g, "").replace(/,(?=\d{3}\b)/g, "").replace(",", ".")) : NaN
    if (!Number.isFinite(amount) || amount <= 0) continue
    const factors = a.match(/\bdata-factors="([^"]*)"/i)?.[1]?.split(",").map(Number) ?? []
    out.push({
      method: title || a.match(/\bvalue="(\d+)"/)?.[1] || "?",
      currency: cy.toUpperCase(),
      price: Math.round(amount * 100) / 100,
      priceText: pv!,
      sellerPrice: Number.isFinite(factors[0]) && factors[0] > 0 ? Math.round(factors[0] * 100) / 100 : undefined,
    })
  }
  return out
}

/**
 * One price, never mixing currencies: the cheapest buyer price in the preferred currency.
 * `usedFallback` = the preferred currency is missing and `chosen` is in another one (the parser then reads NO price).
 */
export function pickPrice(options: PriceOption[], preferred = "USD"): { chosen?: PriceOption; currencies: string[]; usedFallback: boolean } {
  const currencies = [...new Set(options.map(o => o.currency))]
  if (!options.length) return { currencies, usedFallback: false }
  const want = preferred.toUpperCase()
  const cur = currencies.includes(want) ? want : currencies[0]
  const chosen = options.filter(o => o.currency === cur).sort((a, b) => a.price - b.price)[0]
  return { chosen, currencies, usedFallback: cur !== want }
}

const SYMBOL_CURRENCY: [RegExp, string][] = [[/€|\beur\b/i, "EUR"], [/\$|\busd\b/i, "USD"], [/₽|\brub\b|руб/i, "RUB"]]
const currencyOfText = (t?: string) => SYMBOL_CURRENCY.find(([re]) => t && re.test(t))?.[1]

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
    const id = this.canonicalId(finalUrl) || `funpay:${finalUrl.searchParams.get("id") ?? "?"}`
    const base: SourceOffer = { source: "funpay", canonicalId: id, url: finalUrl.href, status: "ok", httpStatus: status, params: {}, images: [], warnings: [] }

    // Dead: HTTP 404/410, or the page heading says so. Never the whole page text: a live offer's
    // description could contain "offer not found" and must not be reported as dead.
    const h1 = htmlToText(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "").toLowerCase()
    if (status === 404 || status === 410 || (h1 && notFoundPhrases().some(p => h1.includes(p)))) {
      return { ...base, status: "not_found", message: "Offer not found at this link" }
    }
    if (status === 403 || status === 429 || status === 503 || /just a moment|cf-chl|captcha/i.test(html.slice(0, 20000))) {
      return { ...base, status: "blocked", message: `The site blocked the check (HTTP ${status})` }
    }
    if (status >= 400) return { ...base, status: "error", message: `The page returned HTTP ${status}` }

    const paramList = section(html, /<div class="param-list"/i, /<div class="chat-float-container"|<form\b|<div class="js-order-prices/i)
    if (!paramList) {
      // Unknown layout (maintenance page, login wall, redesign): unknown, never dead.
      return { ...base, status: "error", message: "Offer page layout not recognised (no parameter list)" }
    }
    const blocks = extractLabelledBlocks(paramList)
    const warnings: string[] = []

    const pick = (names: string[]) => Object.entries(blocks).find(([k]) => names.includes(k.toLowerCase()))?.[1]
    const title = pick(LABELS.short)
    if (!title) warnings.push("no 'Short description' (title) block")
    const description = pick(LABELS.detailed)
    if (!description) warnings.push("no 'Detailed description' block")

    const params: Record<string, string> = {}
    const skip = [...LABELS.short, ...LABELS.detailed, ...LABELS.notParams]
    for (const [k, v] of Object.entries(blocks)) {
      if (skip.includes(k.toLowerCase())) continue
      if (v && v.length <= 200) params[k] = v
    }

    const { category, categoryId } = extractCategory(html)
    const sellerName = htmlToText(html.match(/class="media-user-name">\s*<a\b[^>]*\/users\/\d+\/?"[^>]*>([\s\S]*?)<\/a>/i)?.[1] || "") || undefined
    if (!category) warnings.push("category not found")

    const images = extractGallery(html, finalUrl)
    const externalMedia = externalMediaLinks(description)
    if (!images.length) warnings.push(externalMedia.length ? "no images on FunPay; the description links to screenshots/video elsewhere" : "no images on FunPay")

    // Price = what a buyer pays in USD (decided with the user). No USD option on the page -> no price, flagged; never another currency.
    const options = extractPriceOptions(html)
    const want = (process.env.SOURCE_PRICE_CURRENCY || "USD").toUpperCase()
    const { chosen, currencies, usedFallback } = pickPrice(options, want)
    const usable = chosen && !usedFallback ? chosen : undefined
    let price = usable?.price
    let priceText = usable?.priceText
    let currency = usable?.currency
    if (usedFallback) warnings.push(`no ${want} price on the page (it offers ${currencies.join(", ")}); price not read`)
    if (!options.length) {
      const p = extractPrice(html) // older generic reader, only when the buy form isn't there
      const cur = currencyOfText(p?.priceText)
      if (p && cur === want) {
        price = p.price
        priceText = p.priceText.replace(/^from\s+/i, "")
        currency = cur
        warnings.push("price read without the buy form; check it")
      } else warnings.push(p ? `price found but not in ${want} (${p.priceText}); price not read` : "price not found")
    }

    return {
      ...base,
      title,
      description,
      params,
      category,
      categoryId,
      sellerName,
      game: gameFromCategory(category),
      images,
      externalMedia,
      price,
      priceText,
      currency,
      sellerPrice: usable?.sellerPrice,
      priceOptions: options.length ? options : undefined,
      warnings,
    }
  },
}
