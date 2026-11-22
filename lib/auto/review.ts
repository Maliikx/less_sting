import { findViolations } from "../cleaning/clean"
import { listingProblems, resolvePrice } from "../offerRules"
import type { Flag, PreparedOffer } from "../pipeline/prepare"
import { IMGUR_MESSAGE } from "./messages"
import { roundPrice, roundingMessage } from "./pricing"
import type { PublishItem } from "../destinations/types"

/**
 * Re-check one reviewed row after the employee edits it in the table (title, description, images, price, game).
 * Only the problems an edit can fix are re-computed; everything else the server found stays.
 * The server checks again before publishing (it also knows BLOCKLIST_EXTRA).
 */

export type ReviewRow = PreparedOffer

const FIXABLE = new Set(["price_rounded", "no_images", "imgur_images", "title", "price", "violation", "description", "game_unknown", "images"])

export function revalidate(row: ReviewRow): ReviewRow {
  if (row.status === "dead" || row.status === "duplicate" || row.status === "blocked" || row.status === "error") return row
  const flags: Flag[] = row.flags.filter(f => !FIXABLE.has(f.code))
  const add = (code: string, message: string) => flags.push({ level: "error", code, message })

  if (!row.images.length) {
    if (row.imgurImages) add("imgur_images", IMGUR_MESSAGE)
    else add("no_images", "No images: add at least one image link")
  }
  else {
    const p = listingProblems({ imageUrls: row.images })
    if (p.length) add("images", p.join("; "))
  }
  if (row.title.trim().length < 3) add("title", "Title is empty or too short")
  if (row.title.length > 255) add("title", "Title is over 255 characters")
  // An empty description is fine: publishing uses the seller tag "#<seller>-<link end>" (user decision).
  const price = resolvePrice(row.priceInput, row.sourcePrice !== undefined ? String(row.sourcePrice) : undefined)
  if (price.error) add("price", price.error)
  const rounded = price.value !== undefined ? roundPrice(price.value) : undefined
  if (rounded?.rounded) flags.push({ level: "info", code: "price_rounded", message: roundingMessage(rounded) })
  const left = [...findViolations(row.title), ...findViolations(row.description)]
  if (left.length) add("violation", `Still contains: ${[...new Set(left.map(v => v.text))].join(", ")}`)
  if (!row.game) add("game_unknown", `Pick the GameBoost game for "${row.category || "this category"}"`)

  return {
    ...row,
    flags,
    priceEur: rounded?.value,
    priceBeforeRounding: rounded?.rounded ? rounded.original : undefined,
    status: flags.some(f => f.level === "error") ? "needs_review" : "ready",
  }
}

export const canPublish = (row: ReviewRow) => row.status === "ready" && !!row.game

/** `key` = the row's own id in the batch (unique even when two rows have the same link). */
export function toPublishItem(row: ReviewRow & { key?: string }): PublishItem {
  if (!row.game) throw new Error("no game")
  return {
    ref: row.key || row.canonicalId,
    link: row.link,
    seller: row.seller,
    title: row.title,
    description: row.description,
    images: row.images,
    priceInput: row.priceInput,
    sourcePrice: row.sourcePrice,
    accountData: row.accountData,
    defaulted: row.defaulted.map(d => d.key),
    notes: [...(row.albumImages ? ["album images"] : []), ...(row.defaultImage ? ["default image"] : [])],
    game: row.game,
  }
}
