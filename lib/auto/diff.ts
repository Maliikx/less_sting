/**
 * Word-level diff of the original title against the cleaned one, for the review table:
 * shows exactly which words cleaning removed (banned words, contacts, ads) and which it added (rare: AI/translation).
 */
export type DiffPart = { text: string; kind: "same" | "removed" | "added" }

const words = (s: string) => String(s || "").split(/\s+/).filter(Boolean)
const key = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")

export function diffWords(original: string, cleaned: string): DiffPart[] {
  const a = words(original)
  const b = words(cleaned)
  // LCS table on normalized words (punctuation/emoji spacing changes don't count as removals)
  const n = a.length, m = b.length
  const L = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = key(a[i]) === key(b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out: DiffPart[] = []
  const push = (text: string, kind: DiffPart["kind"]) => {
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.text += ` ${text}`
    else out.push({ text, kind })
  }
  let i = 0, j = 0
  while (i < n && j < m) {
    if (key(a[i]) === key(b[j])) { push(b[j], "same"); i++; j++ }
    else if (L[i + 1][j] >= L[i][j + 1]) push(a[i++], "removed")
    else push(b[j++], "added")
  }
  while (i < n) push(a[i++], "removed")
  while (j < m) push(b[j++], "added")
  return out
}

/** True when cleaning changed more than spacing/punctuation. */
export const titleChanged = (original: string, cleaned: string) => diffWords(original, cleaned).some(p => p.kind !== "same")
