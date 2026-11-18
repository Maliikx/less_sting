/**
 * Pure helpers shared by the browser form and the API routes.
 * (No server imports here, so the form can show the same errors before submitting.)
 */

export const DELIVERY_UNITS = ["minutes", "hours", "days"] as const

/** GameBoost seller rules: these words get listings warned/penalised. */
export const BLACKLIST = [
  "refund",
  "money-back",
  "money back",
  "replacement",
  "lifetime",
  "no warranty",
  "voided warranty",
]

/**
 * GameBoost search ignores keywords glued to an emoji ("🔥Gold" is not found by "gold").
 * Instead of making employees fix it, put a space after every emoji group automatically.
 */
const EMOJI_RUN = /([\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D\u20E3]+)(?=[^\s\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D\u20E3])/gu

export function fixTitle(title: string) {
  return String(title || "").replace(EMOJI_RUN, "$1 ").replace(/\s+/g, " ").trim()
}

/* ------------------------------------------------------------ word filter */

/** Words/phrases from the filter box: one per line or comma separated. */
export function parseFilterWords(text: string | undefined) {
  const seen = new Set<string>()
  return String(text || "")
    .split(/[\n,]+/)
    .map(w => w.trim())
    .filter(w => w && !seen.has(w.toLowerCase()) && !!seen.add(w.toLowerCase()))
    // longest first, so "fresh account" is removed before "fresh"
    .sort((a, b) => b.length - a.length)
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const SEP = "[|/•·,;:\\-–—]"

/** Tidy a title after words were cut out: double spaces, "| |", dangling separators, empty ( ). */
function tidyTitle(line: string) {
  return line
    .replace(/[ \t]{2,}/g, " ")
    .replace(new RegExp(`(${SEP})(\\s*${SEP})+`, "g"), "$1")
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(new RegExp(`^\\s*${SEP}+\\s*|\\s*${SEP}+\\s*$`, "g"), "")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

/** Gentler for description lines: keeps leading bullets like "- Full access". */
function tidyDescLine(line: string) {
  return line
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/(\S)[ \t]{2,}/g, "$1 ")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/,([.;:!?])/g, "$1")
    .replace(new RegExp(`[ \\t]*${SEP}+[ \\t]*$`), "")
    .trimEnd()
}

function removeWords(text: string, words: string[]) {
  let out = text
  for (const w of words) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(w)}(?![\\p{L}\\p{N}])`, "giu")
    out = out.replace(re, " ")
  }
  return out
}

/**
 * Remove every filter word/phrase (whole words only, any letter case).
 * "acc" removes "ACC" but leaves "account" alone.
 * Description: only lines that actually contained a word are tidied; other lines stay exactly as typed.
 */
export function applyWordFilter(text: string, words: string[], multiline = false) {
  const src = String(text || "")
  if (!words.length || !src) return src
  if (!multiline) {
    const out = removeWords(src, words)
    return out === src ? src : tidyTitle(out)
  }
  const lines = src.split("\n").map(line => {
    const out = removeWords(line, words)
    if (out === line) return line
    const indent = line.match(/^[ \t]*/)![0]
    const t = tidyDescLine(out).trim()
    return t ? indent + t : null // a line that only held filtered words disappears
  })
  return lines.filter(l => l !== null).join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

/** "#M-43883655": employee + last 8 characters of the source link, added to every description. */
export function descriptionTag(employee: string, link: string) {
  const l = String(link || "").trim().replace(/\/+$/, "")
  return `#${String(employee || "").trim()}-${l.slice(-8)}`
}

/** Description + tag on its own line, cut so the total stays within GameBoost's 2048 chars. */
export function withDescriptionTag(description: string, employee: string, link: string) {
  const tag = descriptionTag(employee, link)
  const base = String(description || "").trim()
  if (base.endsWith(tag)) return base.slice(0, 2048)
  const room = 2048 - tag.length - 2
  return `${base.slice(0, Math.max(0, room)).trimEnd()}\n\n${tag}`
}

// Any multiplier: "x2", "x1.75", "X 2,5", "×3", "*1.9" or "2x"
const MULTIPLIER = /^\s*(?:[x×*]\s*(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*[x×])\s*$/i

export function isMultiplier(price: string) {
  return MULTIPLIER.test(price || "")
}

const toNumber = (v: string) => Number(String(v).trim().replace(",", "."))

/**
 * The sheet's PRICE column accepts either a number ("100") or a multiplier ("x2.2").
 * GameBoost needs a real EUR price, so a multiplier is applied to the source price.
 */
export function resolvePrice(price: string, sourcePrice?: string): { value?: number; error?: string } {
  const p = String(price || "").trim()
  if (!p) return { error: "Price is required" }

  const m = p.match(MULTIPLIER)
  let value: number
  if (m) {
    const src = toNumber(sourcePrice || "")
    if (!sourcePrice?.trim() || !Number.isFinite(src) || src <= 0) {
      return { error: `Price is a multiplier (${p}) but no source price was found on the link - enter it` }
    }
    const factor = toNumber(m[1] ?? m[2])
    if (!Number.isFinite(factor) || factor <= 0) return { error: `"${p}" is not a valid multiplier` }
    value = src * factor
  } else {
    value = toNumber(p)
    if (!Number.isFinite(value)) return { error: "Price must be a number (EUR) or a multiplier like x2" }
  }
  value = Math.round(value * 100) / 100
  if (value < 0.99) return { error: "GameBoost minimum price is 0.99 EUR" }
  return { value }
}

export function parseImageUrls(text: string) {
  return String(text || "")
    .split(/[\n,\s]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

export function parseJsonObject(text: string | undefined, label: string): { value?: Record<string, unknown>; error?: string } {
  const t = String(text || "").trim()
  if (!t) return { value: {} }
  try {
    const v = JSON.parse(t)
    if (!v || typeof v !== "object" || Array.isArray(v)) return { error: `${label} must be a JSON object { ... }` }
    return { value: v as Record<string, unknown> }
  } catch {
    return { error: `${label} is not valid JSON` }
  }
}

/** Checks GameBoost would reject (or penalise) — run before calling the API. */
export function listingProblems(o: {
  title?: string
  description?: string
  dump?: string
  imageUrls?: string[]
  credentials?: string[]
  checkImages?: boolean
}) {
  const problems: string[] = []
  const text = [o.title, o.description, o.dump].filter(Boolean).join(" ").toLowerCase()
  for (const w of BLACKLIST) if (text.includes(w)) problems.push(`contains the banned word "${w}"`)

  if (o.title !== undefined) {
    if (!o.title.trim()) problems.push("title is empty")
    if (o.title.length > 255) problems.push("title is over 255 characters")
  }
  if (o.description !== undefined) {
    if (!o.description.trim()) problems.push("description is empty")
    if (o.description.length > 2048) problems.push("description is over 2048 characters")
  }
  if (o.dump && o.dump.length > 2048) problems.push("keywords/dump is over 2048 characters")

  if (o.checkImages || o.imageUrls) {
    const urls = o.imageUrls || []
    if (!urls.length) problems.push("at least one image URL is required")
    for (const u of urls) {
      if (!/^https?:\/\/\S+$/i.test(u)) problems.push(`"${u}" is not a valid image URL`)
      else if (/(^|\.)imgur\.com/i.test(new URL(u).hostname)) problems.push("imgur images are not supported by GameBoost")
    }
  }
  if (o.credentials) {
    if (!o.credentials.length) problems.push("credentials are required")
    if (o.credentials.some(c => c.length > 500)) problems.push("credentials text is over 500 characters")
  }
  return problems
}

/* ------------------------------------------------------------ listing-detail types */

export type FieldType = "integer" | "number" | "boolean" | "array" | "string"

/** Field names that are clearly counts/levels -> numbers even before GameBoost tells us. */
const NUMERIC_NAME = /(^|_)(count|level|amount|number|qty|quantity|rank_points|rp|mmr|elo|wins|kills|hours|days)$/i

export function guessType(key: string, types: Record<string, FieldType> = {}): FieldType | undefined {
  return types[key] ?? (NUMERIC_NAME.test(key) ? "integer" : undefined)
}

const isEmptyValue = (x: unknown) =>
  x === undefined || x === null || (typeof x === "string" && !x.trim()) || (Array.isArray(x) && !x.length)

/**
 * Make listing details match the types GameBoost wants ("15" -> 15, "yes" -> true, "a, b" -> ["a","b"])
 * and drop empty values (empty optional fields are not sent).
 */
export function coerceAccountData(data: Record<string, unknown>, types: Record<string, FieldType> = {}) {
  const out: Record<string, unknown> = {}
  for (const [k, raw] of Object.entries(data)) {
    if (isEmptyValue(raw)) continue
    const t = guessType(k, types)
    let v: unknown = raw
    const str = typeof raw === "string" ? raw.trim().replace(/[\s\u00a0]/g, "") : null
    if ((t === "integer" || t === "number") && str !== null) {
      const n = Number(str.replace(",", "."))
      if (Number.isFinite(n)) v = t === "integer" ? Math.round(n) : n
    } else if (t === "integer" && typeof raw === "number") {
      v = Math.round(raw)
    } else if (t === "boolean" && typeof raw === "string") {
      if (/^(true|yes|1|y|on)$/i.test(raw.trim())) v = true
      else if (/^(false|no|0|n|off)$/i.test(raw.trim())) v = false
    } else if (t === "array" && typeof raw === "string") {
      v = raw.split(",").map(x => x.trim()).filter(Boolean)
    } else if (t === "string" && (typeof raw === "number" || typeof raw === "boolean")) {
      v = String(raw)
    }
    out[k] = v
  }
  return out
}

/** Offer's own listing details on top of the shared defaults. */
export function mergeAccountData(defaults: string | undefined, own: string | undefined) {
  const a = parseJsonObject(defaults, "Account data").value || {}
  const b = parseJsonObject(own, "Account data").value || {}
  return { ...a, ...b }
}
