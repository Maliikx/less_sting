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
/** Titles also use emoji runs and brackets as separators: "✅DONATE ACCOUNT✅INSTANT DELIVERY【WARRANTY】🔥..." */
const TITLE_SPLIT = /(\s*(?:[|;•·]|[\p{Extended_Pictographic}\u2600-\u27BF\uFE0F\u200D]+|[【】\[\]「」『』])\s*|\s+[-–—]\s+|,\s+)/u

const PAIRS: Record<string, string> = { "【": "】", "[": "]", "(": ")", "「": "」", "『": "』" }
const CLOSERS = new Set(Object.values(PAIRS))
/** Drop brackets left without a partner after a cut, then empty pairs ("【 】"), then repeated emoji ("✅✅"). */
export function tidyBrackets(s: string): string {
  const chars = [...s]
  const stack: number[] = []
  const drop = new Set<number>()
  chars.forEach((c, i) => {
    if (PAIRS[c]) stack.push(i)
    else if (CLOSERS.has(c)) {
      const open = stack.length ? stack[stack.length - 1] : -1
      if (open >= 0 && PAIRS[chars[open]] === c) stack.pop()
      else drop.add(i)
    }
  })
  stack.forEach(i => drop.add(i))
  let out = chars.filter((_, i) => !drop.has(i)).join("")
  for (let k = 0; k < 3; k++) out = out.replace(/【\s*】|\[\s*\]|\(\s*\)|「\s*」|『\s*』/gu, " ")
  return out.replace(/(\p{Extended_Pictographic}\uFE0F?)(?:\s*\1)+/gu, "$1")
}
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
  // a line left with only numbering / emoji / punctuation ("1.", "❤️") after cleaning carries nothing
  const empty = (l: string) => !/\p{L}/u.test(l)
  return s.split("\n").map(fix).map(l => (empty(l) ? "" : l)).filter((l, i, a) => l || (a[i - 1] && a[i + 1] !== undefined)).join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

/**
 * Clean one piece of text.
 *  - a clause that contains a banned term is cut out (the rest of the line stays)
 *  - a sentence with contact details / seller advertising is dropped completely
 * If everything would be removed from a title, the banned words alone are cut instead.
 */
export type CleanOptions = {
  /** Names to remove with their whole sentence (the source seller's username / store name). */
  names?: string[]
}

/** "FAQ" / "Q&A" / "Частые вопросы" heading: the block under it (up to a blank line) is dropped. */
const FAQ_HEADING = /^[^\p{L}\p{N}]*(?:faq|f\.a\.q\.?|q\s*&\s*a|frequently asked questions?|questions? (?:and|&) answers?|частые вопросы|чаво|вопрос[ -]ответ)[^\p{L}\p{N}]*$/iu
/** A question/answer line: "Q:", "A:", "Question:", "Вопрос:", "❓ ...". */
const QA_LINE = /^[^\p{L}\p{N}]*(?:q|a|question|answer|вопрос|ответ)\s*[:.)-]\s|^\s*[❓❔]/iu

const escapeName = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function cleanText(input: string, kind: "title" | "description", custom?: CompiledTerms, opts: CleanOptions = {}): CleanResult {
  const t = terms(custom)
  const removed: Removed[] = []
  const src = String(input || "").replace(/\r\n?/g, "\n")
  if (!src.trim()) return { text: "", removed }
  const names = (opts.names || []).map(n => n.trim()).filter(n => n.length >= 3)
  const nameRe = names.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escapeName).join("|")})(?![\\p{L}\\p{N}])`, "iu") : null
  const sentenceHit = (s: string) => (nameRe && nameRe.test(s) ? { reason: "seller name", match: s } : firstSentenceHit(s))

  const processLine = (line: string): string => {
    const sentences = line.split(SENTENCE_SPLIT)
    const keptSentences: string[] = []
    for (const sentence of sentences) {
      const hit = sentenceHit(sentence)
      if (hit && kind === "description") {
        removed.push({ text: sentence.trim(), reason: hit.reason })
        continue
      }
      // Titles are one line: cut only the clause with the contact/ad hit, not the whole title
      const parts = sentence.split(kind === "title" ? TITLE_SPLIT : CLAUSE_SPLIT) // [clause, sep, clause, sep, ...]
      const out: string[] = []
      for (let i = 0; i < parts.length; i += 2) {
        const clause = parts[i]
        const sep = parts[i + 1] ?? ""
        const bad = (kind === "title" ? sentenceHit(clause) : null) || firstTermHit(clause, t)
        if (bad && clause.trim()) {
          removed.push({ text: clause.trim(), reason: bad.reason })
          // drop the clause; in titles keep a closing bracket that belongs to the previous part
          if (kind === "title" && /[】\]」』)]/u.test(sep)) out.push(sep.replace(/[^】\]」』)]/gu, ""))
          continue
        }
        out.push(clause + sep)
      }
      const joined = out.join("")
      if (joined.trim()) keptSentences.push(joined)
    }
    return keptSentences.join(" ")
  }

  let text: string
  if (kind === "title") text = processLine(src.replace(/\n+/g, " "))
  else {
    // FAQ blocks and Q/A lines are the seller's sales talk, not facts about the account: drop them whole.
    let inFaq = false
    const lines: string[] = []
    for (const l of src.split("\n")) {
      if (!l.trim()) { inFaq = false; lines.push(""); continue }
      if (FAQ_HEADING.test(l)) { inFaq = true; removed.push({ text: l.trim(), reason: "FAQ" }); continue }
      if (inFaq || QA_LINE.test(l)) { removed.push({ text: l.trim(), reason: "FAQ" }); continue }
      lines.push(processLine(l))
    }
    text = lines.join("\n")
  }

  if (kind === "title") text = tidyBrackets(text)
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
