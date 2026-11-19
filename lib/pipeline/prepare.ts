import { cleanText, findViolations, needsTranslation, type Removed } from "../cleaning/clean"
import type { CompiledTerms } from "../cleaning/blocklist"
import { aiExtract } from "../ai/extract"
import { AiUnavailableError, type AiClient } from "../ai/provider"
import { applyDefaults, isEmptyValue, type Defaulted, type FieldSpec } from "../gameFields"
import { descriptionTag, fixTitle, resolvePrice } from "../offerRules"
import { canonicalIdOf } from "../sources/index"
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

/** Cheap field filling from FunPay's own label/value pairs ("Rank: Gold"). No AI needed. */
export function fieldsFromParams(specs: FieldSpec[], params: Record<string, string>): Record<string, unknown> {
  const n = (s: string) => String(s).toLowerCase().replace(/[_\-\s]+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim()
  const out: Record<string, unknown> = {}
  for (const s of specs) {
    const label = Object.keys(params).find(k => n(k) === n(s.key))
    if (!label) continue
    const raw = params[label]
    if (s.options?.length) {
      const hit = s.options.find(o => n(o) === n(raw)) ?? s.options.find(o => n(raw).includes(n(o)))
      if (hit) out[s.key] = s.type === "array" ? [hit] : hit
    } else if (s.type === "integer" || s.type === "number") {
      const m = raw.replace(/[\s,]/g, "").match(/-?\d+(?:\.\d+)?/)
      if (m) out[s.key] = s.type === "integer" ? Math.round(Number(m[0])) : Number(m[0])
    } else if (s.type === "string") {
      out[s.key] = raw
    }
  }
  return out
}

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
  if (!base.images.length && base.game) {
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
  const t = cleanText(src.title || "", "title", deps.terms)
  const d = cleanText(src.description || "", "description", deps.terms)
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
  if (translate || wanted.length) {
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
  const t2 = cleanText(title, "title", deps.terms)
  const d2 = cleanText(description, "description", deps.terms)
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
  if (!base.images.length) {
    flag("error", "no_images", base.game ? `No images: set a default image for ${base.game.name} (asked once per game) or add image links` : "No images found; GameBoost needs at least one")
  }

  /* 7. price */
  const price = resolvePrice(base.priceInput, src.price !== undefined ? String(src.price) : undefined)
  if (price.error) flag("error", "price", price.error)
  else base.priceEur = price.value

  /* 8. required fields: lowest value, and say so */
  const filled = applyDefaults(specs, fields)
  base.accountData = filled.values
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
