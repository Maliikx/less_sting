import { fixTitle } from "../offerRules"
import type { DestinationAdapter, PublishItem, PublishResult, PublishSettings } from "./types"

/**
 * GameBoost destination: a thin wrapper around the EXISTING `POST /api/offers` code path, called in-process.
 * That path keeps doing what it always did: duplicate-title check against the sheet, create on GameBoost
 * (422 type retry, lookup by external_id on unknown outcome), list or leave as draft, and log to the sheet.
 * This file only builds its request body (one per seller + game) and maps its answer back to each row.
 */

/** Same normalisation POST /api/offers uses for titles in its answer (lib/sheets.ts normalize). */
const normalize = (v: string) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ")

export type OffersApiCall = (body: unknown) => Promise<{ status: number; json: Record<string, unknown> }>

export function sheetNote(item: PublishItem) {
  const parts = ["auto"]
  if (item.defaulted.length) parts.push(`defaulted: ${item.defaulted.join(", ")}`)
  for (const n of item.notes || []) parts.push(n)
  return parts.join(" · ")
}

/** One request body per (seller, game), in the shape of the existing form (app/schema.ts formSchema). */
export function buildOffersRequests(items: PublishItem[], s: PublishSettings) {
  const groups = new Map<string, PublishItem[]>()
  for (const it of items) {
    const k = `${it.seller}\u0000${it.game.id}`
    groups.set(k, [...(groups.get(k) || []), it])
  }
  return [...groups.values()].map(group => ({
    items: group,
    body: {
      employee: group[0].seller,
      offers: group.map(it => ({
        title: it.title,
        link: it.link,
        price: it.priceInput,
        sourcePrice: it.sourcePrice !== undefined ? String(it.sourcePrice) : undefined,
        imageUrls: it.images.join("\n"),
        description: it.description,
        accountData: JSON.stringify(it.accountData),
        note: sheetNote(it),
        credentials: s.credentials || undefined,
      })),
      gameboost: {
        enabled: true,
        gameId: group[0].game.id,
        gameSlug: group[0].game.slug,
        gameName: group[0].game.name,
        deliveryDuration: String(s.deliveryDuration),
        deliveryUnit: s.deliveryUnit,
        description: s.defaultDescription || "",
        deliveryInstructions: s.deliveryInstructions || "",
        accountData: "{}",
        requiredFields: "",
        fieldTypes: "{}",
        filterWords: "",
        listNow: s.listNow,
      },
    },
  }))
}

type Answer = {
  error?: string
  published?: { title: string; id: number; status: string; warning?: string }[]
  failed?: { title: string; error: string; missingFields?: string[]; badFields?: string[] }[]
  duplicates?: string[]
}

/** Map one POST /api/offers answer back to the rows of its group (by title, in order). */
export function mapAnswer(items: PublishItem[], status: number, a: Answer): PublishResult[] {
  const pub = [...(a.published || [])]
  const fail = [...(a.failed || [])]
  const dups = [...(a.duplicates || [])]
  const take = <T extends { title: string }>(list: T[], t: string) => {
    const i = list.findIndex(x => x.title === t)
    return i >= 0 ? list.splice(i, 1)[0] : undefined
  }
  const sheetProblem = status >= 500 && a.error ? a.error : undefined
  return items.map(it => {
    const t = normalize(fixTitle(it.title))
    const p = take(pub, t)
    if (p) {
      return {
        ref: it.ref, status: "created", offerId: p.id, offerStatus: p.status,
        warning: [p.warning, sheetProblem && "created on GameBoost but NOT written to the sheet - do not publish again"].filter(Boolean).join("; ") || undefined,
      }
    }
    const f = take(fail, t)
    if (f) {
      const extra = [f.missingFields?.length && `missing: ${f.missingFields.join(", ")}`, f.badFields?.length && `check: ${f.badFields.join(", ")}`].filter(Boolean)
      return { ref: it.ref, status: "failed", error: [f.error, ...extra].join(" | ") }
    }
    const d = dups.indexOf(t)
    if (d >= 0) {
      dups.splice(d, 1)
      return { ref: it.ref, status: "duplicate", error: "A listing with this title is already in the sheet" }
    }
    return { ref: it.ref, status: "failed", error: a.error || `No result from the publish step (HTTP ${status})` }
  })
}

/** An offer that is already on GameBoost (e.g. created by a publish that timed out before writing the sheet). */
export type ExistingOffer = { id: number; status: string; externalId?: string | null; price?: string | number }

export type GameBoostDestinationOptions = {
  /** Look for an offer with this exact title on GameBoost. null = not there. */
  findExisting?: (item: PublishItem) => Promise<ExistingOffer | null>
  /** Append sheet rows for offers found on GameBoost (never edits existing rows). */
  logExisting?: (found: { item: PublishItem; offer: ExistingOffer }[]) => Promise<void>
}

/**
 * Publish = for each (seller, game) group:
 *  1. offers already on GameBoost with the same title are NOT created again; their missing sheet row is added
 *     (this makes a retry after a timeout safe);
 *  2. the rest go through the existing POST /api/offers (create + sheet log in one call).
 * The browser sends small chunks so each call finishes well inside the function time limit.
 */
export function gameboostDestination(callOffersApi: OffersApiCall, opts: GameBoostDestinationOptions = {}): DestinationAdapter {
  return {
    id: "gameboost",
    async publish(items, settings) {
      const out: PublishResult[] = []
      const found: { item: PublishItem; offer: ExistingOffer }[] = []
      const toCreate: PublishItem[] = []
      // Look all titles up at once (reads are cheap: 1000/min), then decide per offer.
      const checks = await Promise.all(
        items.map(async it => {
          try {
            return { it, existing: opts.findExisting ? await opts.findExisting(it) : null }
          } catch (e) {
            return { it, error: e instanceof Error ? e.message : String(e) }
          }
        })
      )
      for (const c of checks) {
        if ("error" in c) {
          // Can't tell whether it exists: don't risk a duplicate, don't create it.
          out.push({ ref: c.it.ref, status: "failed", error: `Could not check GameBoost for an existing offer (${c.error}). Try again.` })
        } else if (c.existing) found.push({ item: c.it, offer: c.existing })
        else toCreate.push(c.it)
      }

      if (found.length) {
        let logError: string | undefined
        try {
          await opts.logExisting?.(found)
        } catch (e) {
          logError = `already on GameBoost, but the sheet row could not be added: ${e instanceof Error ? e.message : String(e)}`
        }
        for (const { item, offer } of found) {
          out.push({
            ref: item.ref, status: "created", offerId: offer.id, offerStatus: offer.status,
            warning: logError || "was already on GameBoost (an earlier publish was interrupted); not created again, sheet row added",
          })
        }
      }

      for (const { items: group, body } of buildOffersRequests(toCreate, settings)) {
        let res: { status: number; json: Record<string, unknown> }
        try {
          res = await callOffersApi(body)
        } catch (e) {
          // Outcome unknown for this group: say so plainly, never retry blindly (could double-create).
          const msg = `Publish call failed (${e instanceof Error ? e.message : String(e)}). Press Publish again: offers already created are found and not duplicated.`
          out.push(...group.map(it => ({ ref: it.ref, status: "failed" as const, error: msg })))
          continue
        }
        out.push(...mapAnswer(group, res.status, res.json as Answer))
      }
      const order = new Map(items.map((it, i) => [it.ref, i]))
      return out.sort((a, b) => (order.get(a.ref) ?? 0) - (order.get(b.ref) ?? 0))
    },
  }
}

/** Same title test POST /api/offers uses for its duplicate check (normalized, emojis spaced). */
export const sameTitle = (a: string, b: string) => normalize(fixTitle(a)) === normalize(fixTitle(b))

/** Sheet row (A-L) for an offer found on GameBoost, in the same layout POST /api/offers writes. */
export function sheetRowForExisting(item: PublishItem, offer: ExistingOffer, now: string): (string | number)[] {
  return [
    item.link.trim(), item.priceInput, item.seller, fixTitle(item.title), `${sheetNote(item)} · recovered after an interrupted publish`, now,
    offer.id, offer.status, offer.externalId || "", offer.price ?? "", item.game.name, now,
  ]
}
