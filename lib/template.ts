/**
 * Reads GameBoost's per-game template and works out the "listing details" (account_data) fields,
 * whatever shape the template uses. Also reads field names out of GameBoost validation errors.
 */
/** Offer-level keys: never listing details. */
const NOT_ACCOUNT_DATA = new Set([
  "login", "password", "email_login", "email_password", "email_provider", "credentials",
  "game", "game_id", "game_slug", "title", "slug", "description", "dump", "price", "private_note",
  "external_id", "image_urls", "images", "is_manual", "delivery_time", "delivery_instructions",
  "game_items", "id", "name", "status", "created_at", "updated_at",
])

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v)

/** Find the first value stored under one of `keys`, at any depth. */
export function deepFind(v: unknown, keys: string[], depth = 0): unknown {
  if (depth > 6 || !v || typeof v !== "object") return undefined
  if (isObj(v)) {
    for (const k of keys) if (k in v && v[k] !== null && v[k] !== undefined) return v[k]
    for (const child of Object.values(v)) {
      const r = deepFind(child, keys, depth + 1)
      if (r !== undefined) return r
    }
  } else if (Array.isArray(v)) {
    for (const child of v) {
      const r = deepFind(child, keys, depth + 1)
      if (r !== undefined) return r
    }
  }
  return undefined
}

/**
 * [{ key/name/slug: "platform", options: [...], default, ... }]  ->  { platform: { options, default } }
 * so field descriptions in list form work the same as an example object.
 */
function fromFieldList(list: unknown[]): Obj | null {
  const out: Obj = {}
  for (const f of list) {
    if (!isObj(f)) return null
    const key = (f.key ?? f.name ?? f.slug ?? f.field ?? f.id) as string | undefined
    if (!key || typeof key !== "string") return null
    out[key] = "options" in f || "values" in f || "enum" in f || "choices" in f || "default" in f ? f : f.example ?? f.value ?? ""
  }
  return out
}

/** Work out the listing-detail fields from whatever shape the template has. */
export function extractAccountData(raw: unknown): Obj {
  const t = (isObj(raw) && "data" in raw ? raw.data : raw) as unknown

  let found = deepFind(t, ["account_data", "accountData"])
  if (found === undefined) found = deepFind(t, ["fields", "parameters", "attributes"])

  let obj: Obj | null = null
  if (Array.isArray(found)) obj = fromFieldList(found)
  else if (isObj(found)) obj = found

  // Template is an example offer with the account fields mixed in at the top
  if (!obj && isObj(t)) {
    obj = Object.fromEntries(Object.entries(t).filter(([k]) => !NOT_ACCOUNT_DATA.has(k)))
  }
  return Object.fromEntries(Object.entries(obj || {}).filter(([k]) => !NOT_ACCOUNT_DATA.has(k)))
}


export type FieldType = "integer" | "number" | "boolean" | "array" | "string"

/** Read GameBoost's account_data errors: field -> message (first message per field). */
export function accountDataErrors(errors: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isObj(errors)) return out
  for (const [k, v] of Object.entries(errors)) {
    const m = k.match(/^account_data\.([^.]+)/)
    if (m && !out[m[1]]) out[m[1]] = Array.isArray(v) ? v.map(String).join(" ") : String(v)
  }
  return out
}

/** All account_data fields GameBoost complained about. */
export function accountDataFieldsFromErrors(errors: unknown): string[] {
  return Object.keys(accountDataErrors(errors))
}

/** Only the fields GameBoost says are *required* (not type errors like "must be an integer"). */
export function requiredFieldsFromErrors(errors: unknown): string[] {
  return Object.entries(accountDataErrors(errors)).filter(([, m]) => /required/i.test(m)).map(([k]) => k)
}

/** "must be an integer" -> integer, "must be a number" -> number, ... */
export function typesFromErrors(errors: unknown): Record<string, FieldType> {
  const out: Record<string, FieldType> = {}
  for (const [k, m] of Object.entries(accountDataErrors(errors))) {
    if (/must be an integer/i.test(m)) out[k] = "integer"
    else if (/must be a number|must be numeric/i.test(m)) out[k] = "number"
    else if (/true or false|must be a boolean/i.test(m)) out[k] = "boolean"
    else if (/must be an array/i.test(m)) out[k] = "array"
    else if (/must be a string/i.test(m)) out[k] = "string"
  }
  return out
}

/** Fields the template itself marks as required ({ required: true }, rules: "required|...", optional: false). */
export function requiredFromTemplate(accountData: Record<string, unknown>): string[] {
  return Object.entries(accountData)
    .filter(([, v]) => {
      if (!isObj(v)) return false
      if (v.required === true || v.is_required === true || v.optional === false || v.nullable === false) return true
      const rules = v.rules ?? v.validation
      return (typeof rules === "string" && /\brequired\b/.test(rules)) || (Array.isArray(rules) && rules.includes("required"))
    })
    .map(([k]) => k)
}
