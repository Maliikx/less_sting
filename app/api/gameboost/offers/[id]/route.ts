import { NextResponse } from "next/server"
import {
  deleteOffer,
  errorMessage,
  GameBoostError,
  getOffer,
  publicOffer,
  updateOffer,
  type UpdateOfferPayload,
} from "@/lib/gameboost"
import { errorResponse } from "@/lib/apiHelpers"
import { DELIVERY_UNITS, fixTitle, listingProblems, parseImageUrls, resolvePrice } from "@/lib/offerRules"
import { mirrorToSheet } from "@/lib/sheetSync"
import { googleErrorDetails } from "@/lib/sheets"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

/** Statuses an offer can safely be edited/deleted in. Never touch sold/processing/refunded ones. */
const EDITABLE = ["draft", "listed", "pending"]

function badId(id: string) {
  return !/^\d+$/.test(id)
}

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  if (badId(id)) return NextResponse.json({ error: "Invalid offer id" }, { status: 400 })
  try {
    return NextResponse.json({ offer: publicOffer(await getOffer(id)) })
  } catch (e) {
    return errorResponse(e, `GET offer ${id}`)
  }
}

/**
 * PATCH /api/gameboost/offers/:id  — edit an offer.
 * Body: any of { title, description, price, image_urls (array or text), dump,
 *                delivery_time: {duration, unit}, delivery_instructions, account_data }
 * Only send what changed: GameBoost allows max 10 writes per offer per hour.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  if (badId(id)) return NextResponse.json({ error: "Invalid offer id" }, { status: 400 })
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid body" }, { status: 400 })

  const changes: UpdateOfferPayload = {}
  const problems: string[] = []

  if (typeof body.title === "string") changes.title = fixTitle(body.title)
  if (typeof body.description === "string") changes.description = body.description.trim()
  if (typeof body.dump === "string") changes.dump = body.dump.trim()
  if (typeof body.delivery_instructions === "string") changes.delivery_instructions = body.delivery_instructions.trim()

  if (body.price !== undefined) {
    const p = resolvePrice(String(body.price))
    if (p.error) problems.push(p.error)
    else changes.price = p.value
  }
  if (body.image_urls !== undefined) {
    changes.image_urls = Array.isArray(body.image_urls)
      ? body.image_urls.map(String).map(s => s.trim()).filter(Boolean)
      : parseImageUrls(String(body.image_urls))
  }
  if (body.delivery_time !== undefined) {
    const dt = body.delivery_time as { duration?: unknown; unit?: unknown }
    const duration = Number(dt?.duration)
    const unit = String(dt?.unit) as (typeof DELIVERY_UNITS)[number]
    if (!Number.isInteger(duration) || duration <= 0 || !DELIVERY_UNITS.includes(unit)) {
      problems.push("delivery time needs a whole number and minutes/hours/days")
    } else {
      // We only sell manual delivery; GameBoost wants delivery_time with is_manual
      changes.is_manual = true
      changes.delivery_time = { duration, unit }
    }
  }
  if (body.account_data !== undefined) {
    if (!body.account_data || typeof body.account_data !== "object" || Array.isArray(body.account_data)) {
      problems.push("account_data must be a JSON object")
    } else changes.account_data = body.account_data as Record<string, unknown>
  }

  problems.push(
    ...listingProblems({
      title: changes.title,
      description: changes.description,
      dump: changes.dump,
      imageUrls: changes.image_urls,
    })
  )
  if (problems.length) return NextResponse.json({ error: problems.join("; ") }, { status: 422 })
  if (!Object.keys(changes).length) return NextResponse.json({ error: "Nothing to change" }, { status: 400 })

  try {
    const current = await getOffer(id)
    if (!EDITABLE.includes(current.status)) {
      return NextResponse.json(
        { error: `This offer is "${current.status}" - only draft/listed/pending offers can be edited` },
        { status: 409 }
      )
    }
    const updated = await updateOffer(id, changes)
    let sheetWarning: string | undefined
    try {
      await mirrorToSheet(updated)
    } catch (err) {
      console.error("PATCH: sheet mirror failed", googleErrorDetails(err))
      sheetWarning = "Saved on GameBoost, but the sheet row could not be updated"
    }
    return NextResponse.json({ offer: publicOffer(updated), sheetWarning })
  } catch (e) {
    return errorResponse(e, `PATCH offer ${id}`)
  }
}

/**
 * DELETE /api/gameboost/offers/:id  — PERMANENT delete.
 * Guard rails: only draft/listed/pending offers with no orders. The sheet row is kept
 * (so daily counts stay right) and its GB_STATUS becomes "deleted".
 */
export async function DELETE(req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  const rowHint = Number(new URL(req.url).searchParams.get("row")) || undefined
  if (badId(id)) return NextResponse.json({ error: "Invalid offer id" }, { status: 400 })

  let offer
  try {
    offer = await getOffer(id)
  } catch (e) {
    if (e instanceof GameBoostError && e.status === 404) {
      await mirrorToSheet({ id: Number(id) }, { deleted: true }).catch(() => {})
      return NextResponse.json({ success: true, alreadyGone: true })
    }
    return errorResponse(e, `DELETE offer ${id} (lookup)`)
  }

  if (!EDITABLE.includes(offer.status)) {
    return NextResponse.json(
      { error: `Refusing to delete: offer is "${offer.status}". Only draft/listed/pending offers can be deleted.` },
      { status: 409 }
    )
  }
  if (offer.account_order_ids?.length) {
    return NextResponse.json(
      { error: `Refusing to delete: offer has order(s) ${offer.account_order_ids.join(", ")}` },
      { status: 409 }
    )
  }

  try {
    await deleteOffer(id)
  } catch (e) {
    if (!(e instanceof GameBoostError && e.status === 404)) return errorResponse(e, `DELETE offer ${id}`)
  }

  let sheetWarning: string | undefined
  try {
    await mirrorToSheet(offer, { deleted: true, rowHint })
  } catch (err) {
    console.error("DELETE: sheet mirror failed", googleErrorDetails(err))
    sheetWarning = `Deleted on GameBoost, but the sheet row could not be marked: ${errorMessage(err)}`
  }
  return NextResponse.json({ success: true, sheetWarning })
}
