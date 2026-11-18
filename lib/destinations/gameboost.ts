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
      })),
      gameboost: {
        enabled: true,
        gameId: group[0].game.id,
        gameSlug: group[0].game.slug,
        gameName: group[0].game.name,
        deliveryDuration: String(s.deliveryDuration),
        deliveryUnit: s.deliveryUnit,
        description: s.defaultDescription || "",
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

export function gameboostDestination(callOffersApi: OffersApiCall): DestinationAdapter {
  return {
    id: "gameboost",
    async publish(items, settings) {
      const out: PublishResult[] = []
      for (const { items: group, body } of buildOffersRequests(items, settings)) {
        let res: { status: number; json: Record<string, unknown> }
        try {
          res = await callOffersApi(body)
        } catch (e) {
          // Outcome unknown for this group: say so plainly, never retry blindly (could double-create).
          const msg = `Publish call failed (${e instanceof Error ? e.message : String(e)}). Check /manage before publishing these again.`
          out.push(...group.map(it => ({ ref: it.ref, status: "failed" as const, error: msg })))
          continue
        }
        out.push(...mapAnswer(group, res.status, res.json as Answer))
      }
      return out
    },
  }
}
