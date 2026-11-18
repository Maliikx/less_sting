import { compileTerms, SENTENCE_PATTERNS, type CompiledTerms } from "./blocklist"

export type Removed = { text: string; reason: string }
export type CleanResult = { text: string; removed: Removed[] }

/** Share of letters that are Cyrillic. Used to decide whether translation is needed (no model involved). */
export function cyrillicRatio(text: string): number {
  const letters = String(text || "").match(/\p{L}/gu) || []
  if (!letters.length) return 0
  const cyr = letters.filter(c => /\p{Script=Cyrillic}/u.test(c)).length
  return cyr / letters.length
}

export const needsTranslation = (text: string) => cyrillicRatio(text) > 0.15

let defaultTerms: CompiledTerms | null = null
const terms = (custom?: CompiledTerms) => custom ?? (defaultTerms ??= compileTerms())

/** Clause separators we may cut at without breaking grammar: | ; • · , and spaced dashes. */
const CLAUSE_SPLIT = /(\s*[|;•·]\s*|\s+[-–—]\s+|,\s+)/u
const SENTENCE_SPLIT = /(?<=[.!?])\s+/u

const firstTermHit = (s: string, t: CompiledTerms) => {
  for (const g of t) {
    g.re.lastIndex = 0
    const m = g.re.exec(s)
    if (m) return { reason: g.reason, match: m[0] }
  }
  return null
}

const firstSentenceHit = (s: string) => {
  for (const p of SENTENCE_PATTERNS) {
    const m = p.re.exec(s)
    if (m) return { reason: p.reason, match: m[0] }
  }
  return null
}

/** Words that dangle at the end after a cut ("Account with" / "Аккаунт с"). */
const DANGLING_END = /(?:\s+(?:with|and|for|the|a|an|of|to|in|on|&|\+|и|с|со|на|для|в|от))+$/iu

function tidy(s: string, multiline: boolean): string {
  const fix = (line: string) =>
    line
      .replace(/\(\s*\)|\[\s*\]/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/,\s*([.;:!?])/g, "$1")
      .replace(/^[\s|;,•·\-–—:]+|[\s|;,•·\-–—:]+$/gu, "")
      .replace(DANGLING_END, "")
      .trim()
  if (!multiline) return fix(s)
  return s.split("\n").map(fix).filter((l, i, a) => l || (a[i - 1] && a[i + 1] !== undefined)).join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

/**
 * Clean one piece of text.
 *  - a clause that contains a banned term is cut out (the rest of the line stays)
 *  - a sentence with contact details / seller advertising is dropped completely
 * If everything would be removed from a title, the banned words alone are cut instead.
 */
export function cleanText(input: string, kind: "title" | "description", custom?: CompiledTerms): CleanResult {
  const t = terms(custom)
  const removed: Removed[] = []
  const src = String(input || "").replace(/\r\n?/g, "\n")
  if (!src.trim()) return { text: "", removed }

  const processLine = (line: string): string => {
    const sentences = line.split(SENTENCE_SPLIT)
    const keptSentences: string[] = []
    for (const sentence of sentences) {
      const hit = firstSentenceHit(sentence)
      if (hit && kind === "description") {
        removed.push({ text: sentence.trim(), reason: hit.reason })
        continue
      }
      // Titles are one line: cut only the clause with the contact/ad hit, not the whole title
      const parts = sentence.split(CLAUSE_SPLIT) // [clause, sep, clause, sep, ...]
      const out: string[] = []
      for (let i = 0; i < parts.length; i += 2) {
        const clause = parts[i]
        const sep = parts[i + 1] ?? ""
        const bad = (kind === "title" ? firstSentenceHit(clause) : null) || firstTermHit(clause, t)
        if (bad && clause.trim()) {
          removed.push({ text: clause.trim(), reason: bad.reason })
          continue // drop clause and its trailing separator
        }
        out.push(clause + sep)
      }
      const joined = out.join("")
      if (joined.trim()) keptSentences.push(joined)
    }
    return keptSentences.join(" ")
  }

  let text =
    kind === "title"
      ? processLine(src.replace(/\n+/g, " "))
      : src.split("\n").map(l => (l.trim() ? processLine(l) : "")).join("\n")

  text = tidy(text, kind === "description")

  // A title that lost every clause: keep the words, cut only the banned terms themselves
  if (kind === "title" && !text) {
    let rest = src.replace(/\n+/g, " ")
    for (const g of t) {
      g.re.lastIndex = 0
      rest = rest.replace(g.re, " ")
    }
    text = tidy(rest, false)
  }
  return { text, removed }
}

export type Violation = { text: string; reason: string }

/** Final gate: what is still in the text that must not be. Run on rule output AND on AI output. */
export function findViolations(text: string, custom?: CompiledTerms): Violation[] {
  const t = terms(custom)
  const out: Violation[] = []
  for (const g of t) {
    g.re.lastIndex = 0
    for (const m of String(text || "").matchAll(g.re)) out.push({ text: m[0], reason: g.reason })
  }
  for (const p of SENTENCE_PATTERNS) {
    const m = p.re.exec(String(text || ""))
    if (m) out.push({ text: m[0], reason: p.reason })
  }
  return out
}
