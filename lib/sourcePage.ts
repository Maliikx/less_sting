/**
 * Reads an offer's source page (e.g. a FunPay lot) on the server:
 *  - finds the account's images, so employees don't have to copy them
 *  - detects dead offers ("Offer not found" page, 404/410)
 *
 * Results are only "not_found" when we are sure; blocked/timeouts are "error"
 * so a bulk check never suggests deleting an offer we simply couldn't open.
 */

export type SourceCheck = {
  status: "ok" | "not_found" | "error"
  images: string[]
  /** Price shown on the source page, as a plain number (no currency conversion) */
  price?: number
  /** The text it was read from, e.g. "1 250 ₽" - shown to the employee to double-check */
  priceText?: string
  message?: string
  httpStatus?: number
}

/** Text that means the offer is gone. Extra phrases: SOURCE_NOT_FOUND_PHRASES="phrase one|phrase two" */
export function notFoundPhrases() {
  const extra = (process.env.SOURCE_NOT_FOUND_PHRASES || "")
    .split("|")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
  return ["offer not found", "лот не найден", "предложение не найдено", ...extra]
}

const MAX_BYTES = 3_000_000
const MAX_IMAGES = 10

/* ------------------------------------------------------------ safety */

function isPrivateHost(host: string) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "")
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split(".").map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (h.includes(":")) return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")
  return false
}

function checkUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new Error("Not a valid link")
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only http/https links can be checked")
  if (isPrivateHost(u.hostname) && process.env.SOURCE_ALLOW_PRIVATE_HOSTS !== "1") throw new Error("This link points to a private address")
  return u
}

export async function fetchPage(raw: string): Promise<{ status: number; html: string; finalUrl: URL }> {
  let url = checkUrl(raw)
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    })
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = checkUrl(new URL(res.headers.get("location")!, url).href)
      continue
    }
    // Read at most MAX_BYTES
    const reader = res.body?.getReader()
    let html = ""
    if (reader) {
      const dec = new TextDecoder()
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        html += dec.decode(value, { stream: true })
        if (total > MAX_BYTES) {
          await reader.cancel().catch(() => {})
          break
        }
      }
    }
    return { status: res.status, html, finalUrl: url }
  }
  throw new Error("Too many redirects")
}

/* ------------------------------------------------------------ parsing */

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")

export function pageText(html: string) {
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .toLowerCase()
}

const IMG_EXT = /\.(jpe?g|png|webp)(\?[^"'\s]*)?$/i
const JUNK = /(logo|avatar|icon|sprite|favicon|emoji|flag|badge|banner|placeholder|blank|pixel|loader|spinner|payment|social|\/s\/avatar\/)/i
// Paths that usually hold an offer's own screenshots (FunPay: sfunpay.com/s/offer/...)
const OFFER_HINT = /(\/s\/offer\/|\/offer|\/lot|attach|upload|screen|item|product|gallery)/i

/** Ordered list of the offer's images (best guesses first). */
export function extractImages(html: string, base: URL): string[] {
  const abs = (u: string) => {
    try {
      const t = decode(u.trim())
      // Protocol-relative image links ("//cdn/...") -> always https
      const x = new URL(t.startsWith("//") ? `https:${t}` : t, base)
      return x.protocol === "https:" || x.protocol === "http:" ? x.href : null
    } catch {
      return null
    }
  }
  const strong: string[] = [] // links to full-size images, offer-looking paths
  const weak: string[] = [] // og:image etc.

  // <a href="...jpg"> (gallery / attachment links point at the full-size image)
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const u = abs(m[1])
    if (u && IMG_EXT.test(new URL(u).pathname) && !JUNK.test(u)) strong.push(u)
  }
  // <img src / data-src> only when the path looks like the offer's own picture
  for (const m of html.matchAll(/<img\b[^>]*?\b(?:data-src|data-original|src)\s*=\s*["']([^"']+)["']/gi)) {
    const u = abs(m[1])
    if (u && IMG_EXT.test(new URL(u).pathname) && !JUNK.test(u) && OFFER_HINT.test(u)) strong.push(u)
  }
  // Open Graph / Twitter preview image, unless it's the site logo
  for (const m of html.matchAll(/<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:image|twitter:image)(?::src)?["'][^>]*>/gi)) {
    const c = m[0].match(/content\s*=\s*["']([^"']+)["']/i)
    const u = c && abs(c[1])
    if (u && !JUNK.test(u)) weak.push(u)
  }

  const seen = new Set<string>()
  return [...strong, ...weak].filter(u => !/imgur\.com/i.test(u) && !seen.has(u) && seen.add(u)).slice(0, MAX_IMAGES)
}

/* ------------------------------------------------------------ price */

/** "1 250,50 ₽" / "$1,234.56" / "12.34 €" / "12,34" -> number (currency is ignored on purpose). */
export function parseAmount(text: string): number | undefined {
  const m = String(text).replace(/\u00a0|\u202f/g, " ").match(/\d[\d .,']*/)
  if (!m) return undefined
  let n = m[0].trim().replace(/[ ']/g, "")
  const lastDot = n.lastIndexOf("."), lastComma = n.lastIndexOf(",")
  if (lastDot > -1 && lastComma > -1) {
    // the later one is the decimal mark
    n = lastDot > lastComma ? n.replace(/,/g, "") : n.replace(/\./g, "").replace(",", ".")
  } else if (lastComma > -1) {
    // "12,34" decimal; "1,234" thousands
    n = /^\d{1,3}(,\d{3})+$/.test(n) ? n.replace(/,/g, "") : n.replace(",", ".")
  } else if ((n.match(/\./g) || []).length > 1) {
    n = n.replace(/\.(?=.*\.)/g, "")
  }
  n = n.replace(/[.,]$/, "")
  const v = Number(n)
  return Number.isFinite(v) && v > 0 ? v : undefined
}

const CURRENCY = /[€$₽£¥₴₸]|\b(eur|usd|rub|uah|kzt|gbp|руб)\b/i

/** Decode entities until stable: FunPay puts price HTML inside attributes (data-content="&lt;span ...") */
function fullyDecode(html: string) {
  let prev = ""
  let cur = html
  for (let i = 0; i < 3 && cur !== prev; i++) {
    prev = cur
    cur = decode(cur).replace(/&nbsp;|&#160;/g, " ")
  }
  return cur
}

const round2 = (v: number) => Math.round(v * 100) / 100
const textOf = (h: string) => decode(h.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()

/**
 * Best guess at the offer's own price on the source page. Tried in this order:
 *  1. FunPay buy form: "payment-value" (inside the payment-method options) -> lowest one
 *  2. FunPay "tc-price" block with data-s="<number>"
 *  3. Structured data (JSON-LD "price", <meta itemprop="price">, product:price:amount)
 *  4. Any element whose class contains "price"
 *  5. Visible text like "Price: 12.34 €" / "Цена 1 250 ₽" / "Total 9.99"
 */
export function extractPrice(rawHtml: string): { price: number; priceText: string } | undefined {
  const html = fullyDecode(rawHtml.replace(/<script(?![^>]*ld\+json)[\s\S]*?<\/script>/gi, " "))

  // 1. payment-value (one per payment method; fees differ, so take the lowest)
  const pv: { price: number; priceText: string }[] = []
  for (const m of html.matchAll(/class\s*=\s*["'][^"']*\bpayment-value\b[^"']*["'][^>]*>([\s\S]{0,200}?)<\/span>\s*(?:<\/span>)?/gi)) {
    const t = textOf(m[1])
    const v = parseAmount(t)
    if (v !== undefined) pv.push({ price: round2(v), priceText: t.slice(0, 40) })
  }
  if (pv.length) return pv.sort((a, b) => a.price - b.price)[0]

  // 2. tc-price with data-s
  for (const m of html.matchAll(/<[^>]*class\s*=\s*["'][^"']*\btc-price\b[^"']*["'][^>]*>([\s\S]{0,200}?)<\/div>/gi)) {
    const ds = m[0].match(/data-s\s*=\s*["']([\d.,]+)["']/i)
    const v = ds ? parseAmount(ds[1]) : parseAmount(textOf(m[1]))
    if (v !== undefined) return { price: round2(v), priceText: textOf(m[1]).slice(0, 40) || String(v) }
  }

  // 3. structured data
  const ld = html.match(/"price"\s*:\s*"?(\d[\d.,]*)"?/i)
  if (ld) { const v = parseAmount(ld[1]); if (v !== undefined) return { price: round2(v), priceText: ld[1] } }
  for (const m of html.matchAll(/<meta\b[^>]*(?:itemprop|property|name)\s*=\s*["'](?:price|product:price:amount|og:price:amount)["'][^>]*>/gi)) {
    const c = m[0].match(/content\s*=\s*["']([^"']+)["']/i)
    const v = c ? parseAmount(c[1]) : undefined
    if (v !== undefined) return { price: round2(v), priceText: c![1] }
  }

  // 4. any "price" class with a number
  for (const m of html.matchAll(/<(\w+)\b[^>]*class\s*=\s*["'][^"']*price[^"']*["'][^>]*>([\s\S]{0,300}?)<\/\1>/gi)) {
    const t = textOf(m[2])
    const v = parseAmount(t)
    if (v !== undefined) return { price: round2(v), priceText: t.slice(0, 40) }
  }

  // 5. visible text
  const text = textOf(html)
  const tm = text.match(/(?:price|цена|стоимость|total|итого|сумма)\s*:?\s*([€$₽£]?\s*\d[\d\s.,]*\s*(?:[€$₽£]|eur|usd|rub|руб\.?)?)/i)
  if (tm) { const v = parseAmount(tm[1]); if (v !== undefined) return { price: round2(v), priceText: tm[1].trim().slice(0, 40) } }

  return undefined
}

/** For troubleshooting: short pieces of the page around anything that looks like a price. */
export function priceSnippets(rawHtml: string) {
  const html = fullyDecode(rawHtml)
  const out: string[] = []
  for (const m of html.matchAll(/payment-value|tc-price|data-s=|class="[^"]*price|itemprop="price"|цена|price/gi)) {
    const i = m.index ?? 0
    out.push(html.slice(Math.max(0, i - 120), i + 220).replace(/\s+/g, " "))
    if (out.length >= 12) break
  }
  return out
}

/* ------------------------------------------------------------ main */

export type PriceReader = (page: { status: number; html: string; finalUrl: URL }) => { price?: number; priceText?: string; warning?: string } | null

/**
 * `opts.price`: a site-specific price reader (e.g. the FunPay adapter). When it returns non-null, its result is used
 * instead of the generic extractPrice (which can mix currencies). `opts.fetcher` is injectable for tests.
 */
export async function checkSource(
  link: string,
  opts: { debug?: boolean; price?: PriceReader; fetcher?: typeof fetchPage } = {}
): Promise<SourceCheck & { debug?: string[] }> {
  let page
  try {
    page = await (opts.fetcher ?? fetchPage)(link)
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "TimeoutError" ? "The page took too long to open" : e.message) : String(e)
    return { status: "error", images: [], message: msg }
  }
  const { status, html, finalUrl } = page
  const text = pageText(html)

  if (status === 404 || status === 410 || notFoundPhrases().some(p => text.includes(p))) {
    return { status: "not_found", images: [], httpStatus: status, message: "Offer not found at this link" }
  }
  if (status === 403 || status === 429 || status === 503 || /just a moment|cf-chl|captcha/i.test(html.slice(0, 20000))) {
    return { status: "error", images: [], httpStatus: status, message: `The site blocked the check (HTTP ${status}). Try again later.` }
  }
  if (status >= 400) return { status: "error", images: [], httpStatus: status, message: `The page returned HTTP ${status}` }

  const special = opts.price?.(page)
  const price = special ? { price: special.price, priceText: special.priceText, ...(special.warning ? { message: special.warning } : {}) } : extractPrice(html) || {}
  return {
    status: "ok",
    images: extractImages(html, finalUrl),
    ...price,
    httpStatus: status,
    ...(opts.debug ? { debug: [`page length ${html.length}`, ...priceSnippets(html)] } : {}),
  }
}
