import { findViolations } from "../cleaning/clean"
import { listingProblems } from "../offerRules"
import type { PublishItem, PublishSettings } from "../destinations/types"

export const PUBLISH_MAX_ITEMS = 20
const UNITS = ["minutes", "hours", "days"] as const

/**
 * Validate POST /api/auto/publish on the SERVER (the browser's checks are only a convenience):
 * shapes, sizes, at least one usable image, and no banned words left (server knows BLOCKLIST_EXTRA).
 * `settings.listNow` = the user's "List immediately" choice; anything but `true` creates drafts.
 */
export function parsePublishRequest(body: unknown): { error: string } | { items: PublishItem[]; settings: PublishSettings } {
  const b = (body || {}) as { items?: unknown; settings?: Record<string, unknown> }
  if (!Array.isArray(b.items) || !b.items.length) return { error: "No offers selected" }
  if (b.items.length > PUBLISH_MAX_ITEMS) return { error: `At most ${PUBLISH_MAX_ITEMS} offers per publish` }

  const s = b.settings || {}
  const duration = Number(s.deliveryDuration)
  const unit = String(s.deliveryUnit || "")
  if (!Number.isInteger(duration) || duration <= 0) return { error: "Delivery time must be a whole number" }
  if (!(UNITS as readonly string[]).includes(unit)) return { error: "Delivery unit must be minutes, hours or days" }
  const instructions = typeof s.deliveryInstructions === "string" ? s.deliveryInstructions.trim() : ""
  if (instructions.length > 2048) return { error: "Delivery instructions: max 2048 characters" }
  const settings: PublishSettings = {
    listNow: s.listNow === true,
    deliveryInstructions: instructions || undefined,
    deliveryDuration: duration,
    deliveryUnit: unit as PublishSettings["deliveryUnit"],
    defaultDescription: typeof s.defaultDescription === "string" ? s.defaultDescription.slice(0, 2000) : undefined,
  }

  const items: PublishItem[] = []
  const seen = new Set<string>()
  for (const [i, raw] of (b.items as Record<string, unknown>[]).entries()) {
    const it = raw || {}
    const str = (k: string) => (typeof it[k] === "string" ? (it[k] as string) : "")
    const game = it.game as PublishItem["game"] | undefined
    const images = Array.isArray(it.images) ? (it.images as unknown[]).filter((u): u is string => typeof u === "string") : []
    const where = `Offer ${i + 1}`
    if (!str("ref") || seen.has(str("ref"))) return { error: `${where}: missing or repeated id` }
    seen.add(str("ref"))
    if (!/^https?:\/\//.test(str("link"))) return { error: `${where}: bad link` }
    if (!str("seller").trim()) return { error: `${where}: no seller code` }
    if (!str("priceInput").trim()) return { error: `${where}: no price` }
    if (!game || typeof game.id !== "number" || !game.slug) return { error: `${where}: no game` }
    const problems = listingProblems({ title: str("title"), description: str("description") || settings.defaultDescription || "", imageUrls: images })
    if (problems.length) return { error: `${where} (${str("title").slice(0, 40)}): ${problems.join("; ")}` }
    const left = [...findViolations(str("title")), ...findViolations(str("description"))]
    if (left.length) return { error: `${where} (${str("title").slice(0, 40)}): still contains ${[...new Set(left.map(v => v.text))].join(", ")}` }
    items.push({
      ref: str("ref"),
      link: str("link"),
      seller: str("seller").trim(),
      title: str("title"),
      description: str("description"),
      images,
      priceInput: str("priceInput").trim(),
      sourcePrice: typeof it.sourcePrice === "number" ? it.sourcePrice : undefined,
      accountData: it.accountData && typeof it.accountData === "object" ? (it.accountData as Record<string, unknown>) : {},
      defaulted: Array.isArray(it.defaulted) ? (it.defaulted as unknown[]).map(String) : [],
      notes: Array.isArray(it.notes) ? (it.notes as unknown[]).map(String) : [],
      game: { id: game.id, slug: String(game.slug), name: String(game.name || game.slug) },
    })
  }
  return { items, settings }
}
