/**
 * Game "listing details" (GameBoost account_data): what each field is, which are required, and what
 * to send when we could not find a value.
 *
 * RULE (agreed with the user): when a REQUIRED field cannot be found, fill the lowest possible value and
 * report it in `defaulted`, so it can be highlighted and logged. Nothing is silently invented.
 */
import { guessType, type FieldType } from "./offerRules"

export type FieldSpec = {
  key: string
  type: FieldType | "enum"
  required: boolean
  /** Allowed values, lowest/first first. Present for enum fields. */
  options?: string[]
  /** Smallest allowed number, learned from GameBoost errors ("must be at least 1"). */
  min?: number
}

export type Defaulted = { key: string; value: unknown; reason: string }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

function optionsOf(v: unknown): string[] | undefined {
  if (!isObj(v)) return undefined
  const list = v.options ?? v.values ?? v.enum ?? v.choices
  if (!Array.isArray(list) || !list.length) return undefined
  const out = list
    .map(x => (isObj(x) ? (x.value ?? x.key ?? x.name ?? x.label) : x))
    .filter(x => typeof x === "string" || typeof x === "number")
    .map(String)
  return out.length ? out : undefined
}

/** Build field specs from the extracted template fields (lib/template.ts) + required list + learned types. */
export function specsFromTemplate(
  accountData: Record<string, unknown>,
  required: string[],
  types: Record<string, string> = {},
  mins: Record<string, number> = {}
): FieldSpec[] {
  const req = new Set(required)
  const keys = new Set([...Object.keys(accountData), ...required])
  return normalizeSpecs(
    [...keys].map(key => {
      const options = optionsOf(accountData[key])
      const t = options ? "enum" : ((guessType(key, types as Record<string, FieldType>) ?? inferType(accountData[key])) as FieldSpec["type"])
      return { key, type: t, required: req.has(key), options, min: mins[key] }
    })
  )
}

/**
 * GameBoost templates can describe a list field twice: "linkable_platforms" (the list) and "linkable_platforms.*"
 * (one item, with the allowed values). Merge them into ONE array field with the item's options, so we send
 * `linkable_platforms: ["PC"]` instead of a text value plus a stray "linkable_platforms.*" key (GameBoost 422:
 * "account_data.linkable_platforms.0 is invalid").
 */
export function normalizeSpecs(specs: FieldSpec[]): FieldSpec[] {
  const ITEM = /^(.+?)\.(?:\*|\d+)$/
  const byKey = new Map<string, FieldSpec>()
  for (const s of specs) {
    if (ITEM.test(s.key)) continue
    // "is_ranked_ready", "has_email": a yes/no question. GameBoost wants true/false, never text like "Unknown".
    const yesNo = s.type === "string" && !s.options?.length && BOOLEAN_NAME.test(s.key)
    byKey.set(s.key, yesNo ? { ...s, type: "boolean" } : { ...s })
  }
  for (const s of specs) {
    const m = s.key.match(ITEM)
    if (!m) continue
    const parent = byKey.get(m[1]) ?? { key: m[1], type: "array" as const, required: false }
    byKey.set(m[1], {
      ...parent,
      type: "array",
      required: parent.required || s.required,
      options: parent.options?.length ? parent.options : s.options,
    })
  }
  return [...byKey.values()]
}

/** Field names that ask a yes/no question. */
export const BOOLEAN_NAME = /^(?:is|has|have|can|was|were|allow|allows|with|without)_/i

/**
 * Types GameBoost told us in a 422 ("must be true or false", "must be an integer"): apply them to the game's specs so the
 * next batch sends the right type. Options are kept; a field that became boolean loses text options it can't have.
 */
export function applyLearnedTypes(specs: FieldSpec[], types: Record<string, string>): { specs: FieldSpec[]; changed: boolean } {
  let changed = false
  const out = specs.map(s => {
    const t = types[s.key]
    if (!t || t === s.type || !["integer", "number", "boolean", "array", "string"].includes(t)) return s
    changed = true
    return { ...s, type: t as FieldSpec["type"], ...(t === "boolean" || t === "integer" || t === "number" ? { options: undefined } : {}) }
  })
  return { specs: out, changed }
}

function inferType(example: unknown): FieldType {
  if (typeof example === "number") return Number.isInteger(example) ? "integer" : "number"
  if (typeof example === "boolean") return "boolean"
  if (Array.isArray(example)) return "array"
  return "string"
}

/** "must be at least 1" / "may not be less than 5" -> 1 / 5 */
export function minFromMessage(msg: string): number | undefined {
  const m = String(msg).match(/(?:at least|not be (?:less|lower) than|minimum(?: value)? (?:of|is)?)\s*(-?\d+(?:\.\d+)?)/i)
  return m ? Number(m[1]) : undefined
}

/** The lowest value we can send for a field. */
export function lowestValue(spec: FieldSpec): unknown {
  if (spec.options?.length) return spec.type === "array" ? [spec.options[0]] : spec.options[0]
  switch (spec.type) {
    case "integer":
    case "number":
      return spec.min ?? 0
    case "boolean":
      return false
    case "array":
      return []
    default:
      return "Unknown"
  }
}

export function isEmptyValue(x: unknown) {
  return x === undefined || x === null || (typeof x === "string" && !x.trim()) || (Array.isArray(x) && !x.length)
}

/** Fill every required field that is still empty with its lowest value; say which ones. */
export function applyDefaults(specs: FieldSpec[], values: Record<string, unknown>): { values: Record<string, unknown>; defaulted: Defaulted[] } {
  const out = { ...values }
  const defaulted: Defaulted[] = []
  for (const s of specs) {
    if (!s.required || !isEmptyValue(out[s.key])) continue
    const v = lowestValue(s)
    out[s.key] = v
    defaulted.push({
      key: s.key,
      value: v,
      reason: s.options?.length ? "not found; first option used" : "not found; lowest value used",
    })
  }
  return { values: out, defaulted }
}
