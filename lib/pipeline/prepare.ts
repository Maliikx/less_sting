import { cleanText, findViolations, needsTranslation, type Removed } from "../cleaning/clean"
import type { CompiledTerms } from "../cleaning/blocklist"
import { aiExtract } from "../ai/extract"
import { AiUnavailableError, type AiClient } from "../ai/provider"
import { applyDefaults, isEmptyValue, type Defaulted, type FieldSpec } from "../gameFields"
import { descriptionTag, fixTitle, resolvePrice } from "../offerRules"
import { canonicalIdOf } from "../sources/index"
import { IMGUR_MESSAGE } from "../auto/messages"
import type { SourceOffer } from "../sources/types"

/**
 * link + price + seller code  ->  a ready-to-review listing.
 *
 * Order matters for cost: duplicate and dead-link checks come BEFORE any AI call, plain rules run before
 * the AI, and the AI only sees what the rules could not settle. Every step that is not certain adds a flag.
 * Pure orchestration: network and AI are injected, so the whole thing is testable offline.
 */

export type Flag = { level: "error" | "warn" | "info"; code: string; message: string }
export type PrepareInput = { link: string; price: string; seller: string }
export type GameProfile = { gameId?: number; gameSlug?: string; gameName?: string; specs: FieldSpec[] }

export type PrepareDeps = {
  readOffer: (link: string) => Promise<SourceOffer>
  ai: AiClient | null
  game: GameProfile | null
  /**
   * Pick the game from the page (FunPay category) after it is read. Overrides `game` when given.
   * null = unknown game: the offer is flagged `game_unknown` so the user picks it once.
   */
  gameFor?: (src: SourceOffer) => Promise<GameProfile | null>
  /** The game's default image (DEFAULT_IMG tab), used when the offer has no images at all. */
  defaultImageFor?: (gameId: number) => string | null
  /** Same offer earlier in this batch (by lot id): stop before reading the page. Return why, or null. */
  isDuplicate?: (canonicalId: string, link: string) => Promise<string | null> | string | null
  /**
   * Already listed? Checked by TITLE (user decision): the page's original title and the cleaned title are compared
   * with the sheet's TITLE column. Runs after the page is read and cleaned, before any AI call. Return where, or null.
   */
  isDuplicateTitle?: (titles: { original: string; cleaned: string }) => Promise<string | null> | string | null
  /** Used when the source has no usable description. */
  defaultDescription?: string
  terms?: CompiledTerms
}

export type PreparedStatus = "ready" | "needs_review" | "duplicate" | "dead" | "blocked" | "error"

export type PreparedOffer = {
  link: string
  seller: string
  priceInput: string
  canonicalId: string
  status: PreparedStatus
  title: string
  description: string
  images: string[]
  /** Source category ("PUBG Mobile Accounts") and its id: the key for remembering the game. */
  category?: string
  categoryId?: string
  /** GameBoost game this offer goes to (null = unknown, user must pick). */
  game?: { id: number; slug: string; name: string } | null
  /** True when the images come from a linked album instead of the offer page. */
  albumImages?: boolean
  /** True when the only image is the game's default image (the offer had none). */
  defaultImage?: boolean
  /** True when the offer's screenshots exist but only on imgur (GameBoost refuses imgur): flag `imgur_images`, not `no_images`. */
  imgurImages?: boolean
  sourcePrice?: number
  priceText?: string
  priceEur?: number
  accountData: Record<string, unknown>
  /** Required fields we could not find: filled with the lowest value. Shown highlighted and logged. */
  defaulted: Defaulted[]
  removed: Removed[]
  original: { title?: string; description?: string }
  flags: Flag[]
  language: "en" | "translated"
  aiUsed: boolean
  provider?: string
  tokens: number
}

const MAX_IMAGES = 10

/* ------------------------------------------------------------ FunPay parameters -> GameBoost fields (no AI) */

const nrm = (s: string) => String(s).toLowerCase().replace(/[_\-\s]+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim()
const stem = (w: string) => w.replace(/(?:ing|ed|es|s)$/, "") || w
/** Words that carry no subject ("email" is a subject; "not", "type", "account" are not). */
const NO_SUBJECT = new Set(["not", "no", "un", "is", "the", "of", "a", "type", "account", "acc", "status", "has", "have", "with"])
const subjectTokens = (s: string) => new Set(nrm(s).split(" ").map(stem).filter(w => w && !NO_SUBJECT.has(w)))

/** The FunPay parameter label for a GameBoost field key: same name, or the same subject words ("Email linking" ~ email_not_linked). */
export function paramLabelFor(key: string, params: Record<string, string>): string | undefined {
  const exact = Object.keys(params).find(k => nrm(k) === nrm(key))
  if (exact) return exact
  const kt = subjectTokens(key)
  if (!kt.size) return undefined
  const hits = Object.keys(params).filter(label => {
    const lt = subjectTokens(label)
    if (!lt.size) return false
    const shared = [...kt].filter(t => lt.has(t)).length
    return shared > 0 && (shared === kt.size || shared === lt.size)
  })
  return hits.length === 1 ? hits[0] : undefined // ambiguous -> no guess
}

const NEG = /(?:^|\s)(?:not|no|non|un|without|never|нет|не|без)(?:\s|$)|unlinked|unbound|отвяз|не привяз/i
const POS = /(?:^|\s)(?:yes|true|linked|bound|attached|verified|есть|да|привязан\p{L}*)(?:\s|$)/iu
/** +1 / -1 / 0 for a yes/no-ish value ("Email linked" +1, "Not linked" -1, "Europe" 0). */
export function polarity(value: string): 1 | -1 | 0 {
  const v = ` ${nrm(value)} `
  if (NEG.test(v)) return -1
  if (POS.test(v)) return 1
  return 0
}
/** A field whose NAME asks a negative question: email_not_linked, no_phone, unlinked_... */
const negativeKey = (key: string) => /(?:^|_)(?:not|no|non|un|without)(?:_|$)|unlinked|unbound/i.test(key)
const ANY = /(?:^|\s)(?:any|all|every|cross|multi|both|любая|любой|все|кросс)(?:\s|$)/i
const UNKNOWN_OPT = /^(?:unknown|other|none|n\/a|-)$/i

/**
 * Fill fields from FunPay's own label/value pairs ("Rank: Gold", "Email linking: Email linked", "Platform: Any platform").
 * Rules only, no AI; anything unclear is left empty (then AI, then lowest value + flag).
 */
export function fieldsFromParams(specs: FieldSpec[], params: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const s of specs) {
    const label = paramLabelFor(s.key, params)
    if (!label) continue
    const raw = params[label]
    const pol = polarity(raw)
    // yes/no question: the answer flips when the field name is negative (email_not_linked + "Email linked" -> No)
    const answer = pol === 0 ? null : (pol === 1) !== negativeKey(s.key)
    const opts = s.options || []

    if (s.type === "boolean") {
      if (answer !== null) out[s.key] = answer
      continue
    }
    if (opts.length) {
      const yesNo = opts.filter(o => /^(?:yes|true|no|false|да|нет)$/i.test(o.trim()))
      let hit: string | undefined
      if (yesNo.length && answer !== null) hit = yesNo.find(o => /^(?:yes|true|да)$/i.test(o.trim()) === answer)
      if (!hit) hit = opts.find(o => nrm(o) === nrm(raw)) ?? opts.find(o => !UNKNOWN_OPT.test(o) && nrm(raw).includes(nrm(o)))
      if (!hit && pol !== 0 && !yesNo.length) hit = opts.find(o => !UNKNOWN_OPT.test(o) && polarity(o) === pol)
      if (!hit && ANY.test(` ${nrm(raw)} `)) {
        const real = opts.filter(o => !UNKNOWN_OPT.test(o))
        const anyOpt = real.find(o => ANY.test(` ${nrm(o)} `))
        if (anyOpt) hit = anyOpt
        else if (s.type === "array" && real.length) { out[s.key] = real; continue } // "Any platform" = every platform
      }
      if (hit) out[s.key] = s.type === "array" ? [hit] : hit
    } else if (s.type === "integer" || s.type === "number") {
      const m = raw.replace(/[\s,]/g, "").match(/-?\d+(?:\.\d+)?/)
      if (m) out[s.key] = s.type === "integer" ? Math.round(Number(m[0])) : Number(m[0])
    } else if (s.type === "string") {
      out[s.key] = answer !== null && negativeKey(s.key) ? (answer ? "Yes" : "No") : raw
    }
  }
  return out
}

/**
 * Last check on the shape GameBoost gets: no item keys ("linkable_platforms.*"), and list fields always as lists
 * (a single value becomes [value]). Prevents 422s like "account_data.linkable_platforms.0 is invalid".
 */
export function shapeAccountData(specs: FieldSpec[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(values)) {
    if (/[.*]/.test(k)) continue
    const spec = specs.find(s => s.key === k)
    if (spec?.type === "array" && !Array.isArray(v)) {
      if (v === undefined || v === null || v === "") continue
      const item = String(v)
      const opt = spec.options?.find(o => nrm(o) === nrm(item)) ?? spec.options?.find(o => nrm(item).includes(nrm(o)))
      if (spec.options?.length && !opt) continue // not an allowed value: leave it out rather than send something invalid
      out[k] = [opt ?? item]
    } else out[k] = v
  }
  return out
}

/** First-person seller talk left after the rules ("I ask you to...", "my store", "we deliver"). */
const SELLER_VOICE = /(?<![\p{L}\p{N}'’])(?:i|i'm|i’m|i am|me|my|mine|we|we're|our)(?![\p{L}\p{N}'’])/iu

export async function prepareOffer(input: PrepareInput, deps: PrepareDeps): Promise<PreparedOffer> {
  const base: PreparedOffer = {
    link: input.link.trim(),
    seller: input.seller,
    priceInput: input.price.trim(),
    canonicalId: "",
    status: "ready",
    title: "",
    description: "",
    images: [],
    accountData: {},
    defaulted: [],
    removed: [],
    original: {},
    flags: [],
    language: "en",
    aiUsed: false,
    tokens: 0,
  }
  const flag = (level: Flag["level"], code: string, message: string) => base.flags.push({ level, code, message })

  /* 1. same offer twice in this batch (lot id): stop before spending anything */
  const id = canonicalIdOf(base.link)
  if (!id) return { ...base, status: "error", flags: [{ level: "error", code: "bad_link", message: "Not a supported single-offer link" }] }
  base.canonicalId = id
  const dup = await deps.isDuplicate?.(id, base.link)
  if (dup) return { ...base, status: "duplicate", flags: [{ level: "warn", code: "duplicate", message: `Already listed: ${dup}` }] }

  /* 2. read the source page; dead / blocked stop here (no AI cost) */
  const src = await deps.readOffer(base.link)
  if (src.status === "not_found") return { ...base, status: "dead", flags: [{ level: "warn", code: "not_found", message: src.message || "Offer not found" }] }
  if (src.status === "blocked") return { ...base, status: "blocked", flags: [{ level: "warn", code: "blocked", message: src.message || "Blocked by the site - try again later" }] }
  if (src.status === "error") return { ...base, status: "error", flags: [{ level: "error", code: "fetch_error", message: src.message || "Could not read the page" }] }
  for (const w of src.warnings) flag("info", "parse", w)
  const offerType = Object.entries(src.params).find(([k]) => /^(offer type|тип предложения)$/i.test(k))?.[1]
  if (offerType && /\b(rent|rental)\b|аренд/i.test(offerType)) {
    flag("error", "rental", `This is a rental offer (Offer type: ${offerType}), not an account sale`)
  }
  if (src.imagesFrom) flag("warn", "album_images", `Images come from ${src.imagesFrom}, not the offer page: check they show this account`)

  base.original = { title: src.title, description: src.description }
  base.category = src.category
  base.categoryId = src.categoryId
  base.albumImages = !!src.imagesFrom

  let game = deps.game
  if (deps.gameFor) {
    try {
      game = await deps.gameFor(src)
    } catch (e) {
      game = null
      flag("error", "game_unknown", `Could not load the GameBoost game: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!game && !base.flags.some(f => f.code === "game_unknown")) {
      flag("error", "game_unknown", `Pick the GameBoost game for "${src.category || src.game || "this category"}" (asked once, then remembered)`)
    }
  }
  base.game = game?.gameId && game.gameSlug ? { id: game.gameId, slug: game.gameSlug, name: game.gameName || game.gameSlug } : deps.gameFor ? null : undefined
  base.images = src.images.filter(u => !/(^|\.)imgur\.com/i.test(safeHost(u))).slice(0, MAX_IMAGES)
  // Screenshots exist, but only on imgur: a different problem from "no images" (they can be re-uploaded), so no default image.
  base.imgurImages =
    !base.images.length && (src.images.some(u => /(^|\.)imgur\.com/i.test(safeHost(u))) || !!src.albums?.some(a => a.kind === "imgur" && a.unusable > 0))
  if (!base.images.length && base.game && !base.imgurImages) {
    const url = deps.defaultImageFor?.(base.game.id)
    if (url) {
      base.images = [url]
      base.defaultImage = true
      flag("warn", "default_image", `No images on the offer: the default image for ${base.game.name} is used`)
    }
  }
  base.sourcePrice = src.price
  base.priceText = src.priceText
  if (src.currency && src.currency !== "EUR") flag("info", "currency", `Source price is in ${src.currency}; used as-is (no conversion)`)

  /* 3. rules: remove banned terms, contacts, ad sentences */
  const cleanOpts = { names: src.sellerName ? [src.sellerName] : [] }
  const t = cleanText(src.title || "", "title", deps.terms, cleanOpts)
  const d = cleanText(src.description || "", "description", deps.terms, cleanOpts)
  base.removed.push(...t.removed, ...d.removed)
  let title = t.text
  let description = d.text

  /* 3b. already listed? by title (original and cleaned), before any AI cost */
  const dupTitle = await deps.isDuplicateTitle?.({ original: src.title || "", cleaned: fixTitle(title) })
  if (dupTitle) {
    return {
      ...base,
      status: "duplicate",
      title: fixTitle(title),
      flags: [{ level: "warn", code: "duplicate", message: `Already listed (same title): ${dupTitle}` }],
    }
  }

  /* 4. cheap field filling from the page's own parameters */
  const specs = game?.specs ?? []
  const fields: Record<string, unknown> = fieldsFromParams(specs, src.params)

  /* 5. AI only when needed: Russian text, or fields still missing */
  const translate = needsTranslation(`${title} ${description}`)
  const wanted = specs.filter(s => isEmptyValue(fields[s.key]) && (s.required || s.type !== "string" || s.options))
  // The rules can't judge sentences where the seller talks about themselves ("I", "my", "we"): let the AI clean those.
  const sellerVoice = SELLER_VOICE.test(description)
  if (translate || wanted.length || sellerVoice) {
    if (!deps.ai?.available) {
      if (translate) flag("error", "untranslated", "Text is not English and no AI provider is configured")
      else flag("info", "no_ai", "AI not configured: game fields are only read from the page parameters")
    } else {
      try {
        const out = await aiExtract(deps.ai, { title, description, params: src.params, wanted, translate })
        title = out.title
        description = out.description || description
        Object.assign(fields, out.fields)
        base.removed.push(...out.adSentences.map(s => ({ text: s, reason: "seller advertising (AI)" })))
        for (const r of out.rejected) flag("info", "ai_rejected", `${r.key}: ${r.reason}`)
        base.aiUsed = true
        base.provider = out.provider
        base.tokens = out.tokens
        base.language = translate ? "translated" : "en"
      } catch (e) {
        const msg = e instanceof AiUnavailableError ? e.message : `AI error: ${e instanceof Error ? e.message : String(e)}`
        flag(translate ? "error" : "warn", "ai_failed", msg)
      }
    }
  }

  /* 6. final gate: rules again on the final text, then check nothing banned is left */
  const t2 = cleanText(title, "title", deps.terms, cleanOpts)
  const d2 = cleanText(description, "description", deps.terms, cleanOpts)
  base.removed.push(...t2.removed, ...d2.removed)
  title = fixTitle(t2.text)
  description = d2.text || (deps.defaultDescription || "").trim()
  if (!d2.text && description) flag("info", "default_description", "No usable description; the default description is used")
  if (!description && base.seller) {
    // User decision: no description at all -> just the seller tag (the same "#<seller>-<link end>" every listing gets).
    description = descriptionTag(base.seller, base.link)
    flag("info", "seller_tag_description", `No description on the page: "${description}" is used`)
  }

  const left = [...findViolations(title, deps.terms), ...findViolations(description, deps.terms)]
  if (left.length) flag("error", "violation", `Still contains: ${[...new Set(left.map(v => v.text))].join(", ")}`)

  if (title.length < 3) flag("error", "title", "Title is empty or too short after cleaning")
  if (title.length > 255) { title = title.slice(0, 255).trim(); flag("warn", "title_cut", "Title was cut to 255 characters") }
  if (!description) flag("error", "description", "No description and no default description")
  if (description.length > 1900) { description = description.slice(0, 1900).trim(); flag("warn", "description_cut", "Description was shortened") }
  if (!base.images.length && base.imgurImages) {
    flag("error", "imgur_images", IMGUR_MESSAGE)
  } else if (!base.images.length) {
    flag("error", "no_images", base.game ? `No images: set a default image for ${base.game.name} (asked once per game) or add image links` : "No images found; GameBoost needs at least one")
  }

  /* 7. price */
  const price = resolvePrice(base.priceInput, src.price !== undefined ? String(src.price) : undefined)
  if (price.error) flag("error", "price", price.error)
  else base.priceEur = price.value

  /* 8. required fields: lowest value, and say so */
  const filled = applyDefaults(specs, fields)
  base.accountData = shapeAccountData(specs, filled.values)
  base.defaulted = filled.defaulted
  for (const f of filled.defaulted) flag("warn", "defaulted", `${f.key} = ${JSON.stringify(f.value)} (${f.reason})`)

  base.title = title
  base.description = description
  base.status = base.flags.some(f => f.level === "error") ? "needs_review" : "ready"
  return base
}

function safeHost(u: string) {
  try {
    return new URL(u).hostname
  } catch {
    return ""
  }
}
