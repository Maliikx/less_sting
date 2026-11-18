import { canonicalIdOf } from "../sources/index"

/**
 * The /auto paste box: one offer per line, `link price seller` (spaces, tabs or commas).
 * The link is the token that looks like a URL; the price is a number or a multiplier ("x2", "1.75x", "*2");
 * the seller is the remaining token. Order does not matter, so a pasted spreadsheet row works too.
 */

export type BatchLine = { line: number; raw: string; link: string; price: string; seller: string; lotId: string | null; error?: string }

const PRICE = /^(?:[x*×]\s*\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s*[x×]|\d+(?:[.,]\d+)?)$/i

export function parseLine(raw: string, line: number): BatchLine {
  // Tabs or spaces separate fields; commas/semicolons only when there is no whitespace (so "12,5" stays a price).
  const t = raw.trim()
  const tokens = (/\s/.test(t) ? t.split(/\s+/) : t.split(/[,;]+/)).map(x => x.replace(/^[,;]+|[,;]+$/g, "")).filter(Boolean)
  const link = tokens.find(x => /^https?:\/\//i.test(x)) || ""
  const rest = tokens.filter(x => x !== link)
  const price = rest.find(t => PRICE.test(t)) || ""
  const seller = rest.filter(t => t !== price).join(" ")
  const lotId = link ? canonicalIdOf(link) : null
  const error = !link ? "no link" : !lotId ? "not a FunPay single-offer link" : !price ? "no price (number or multiplier like x2)" : !seller ? "no seller code" : undefined
  return { line, raw, link, price: price.replace(",", "."), seller, lotId, ...(error ? { error } : {}) }
}

/** Parse the whole box. Keeps the first line per lot id; later ones are reported as repeated. */
export function parseBatch(text: string): { lines: BatchLine[]; repeated: BatchLine[]; invalid: BatchLine[] } {
  const all = text.split(/\r?\n/).map((raw, i) => ({ raw, i })).filter(x => x.raw.trim()).map(x => parseLine(x.raw, x.i + 1))
  const seen = new Set<string>()
  const lines: BatchLine[] = []
  const repeated: BatchLine[] = []
  const invalid: BatchLine[] = []
  for (const l of all) {
    if (l.error) { invalid.push(l); continue }
    if (seen.has(l.lotId!)) { repeated.push(l); continue }
    seen.add(l.lotId!)
    lines.push(l)
  }
  return { lines, repeated, invalid }
}
