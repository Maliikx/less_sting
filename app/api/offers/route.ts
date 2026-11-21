import { NextResponse } from "next/server"
import { formSchema, type GameBoostSettings, type OfferValues } from "@/app/schema"
import {
  createOffer,
  errorMessage,
  findOfferByExternalId,
  GameBoostError,
  publishOffer,
  type AccountOffer,
  type CreateOfferPayload,
} from "@/lib/gameboost"
import { accountDataFieldsFromErrors, requiredFieldsFromErrors, typesFromErrors } from "@/lib/template"
import { coerceAccountData, mergeAccountData, type FieldType } from "@/lib/offerRules"
import { applyWordFilter, fixTitle, parseFilterWords, parseImageUrls, resolvePrice, withDescriptionTag } from "@/lib/offerRules"
import {
  ensureGameBoostHeaders,
  googleErrorDetails,
  sheetErrorMessage,
  normalize,
  nowStamp,
  readRows,
  writeRowsAt,
  COL,
} from "@/lib/sheets"

export const runtime = "nodejs"
// Creating many offers one after another can take a while
export const maxDuration = 60

const MANUAL_PLACEHOLDER =
  process.env.GAMEBOOST_MANUAL_CREDENTIAL_PLACEHOLDER ||
  "Manual delivery - the seller delivers this account to the buyer through the order chat."

type Failed = { title: string; error: string; missingFields?: string[]; badFields?: string[] }
type Published = { title: string; id: number; status: string; warning?: string }

function makeExternalId(employee: string) {
  const rand = Math.random().toString(36).slice(2, 8)
  return `ls-${employee.replace(/[^a-z0-9]/gi, "").toLowerCase()}-${Date.now().toString(36)}-${rand}`
}

function readTypes(gb: GameBoostSettings): Record<string, FieldType> {
  try {
    const t = JSON.parse(gb.fieldTypes || "{}")
    return t && typeof t === "object" ? t : {}
  } catch {
    return {}
  }
}

function buildPayload(employee: string, offer: OfferValues, gb: GameBoostSettings, externalId: string, types: Record<string, FieldType>): CreateOfferPayload {
  const price = resolvePrice(offer.price, offer.sourcePrice).value!
  // Shared defaults + this offer's own values, converted to the right types ("15" -> 15);
  // empty optional fields are left out so GameBoost doesn't reject "" values
  const accountData = coerceAccountData(mergeAccountData(gb.accountData, offer.accountData), types)
  const payload: CreateOfferPayload = {
    game_id: gb.gameId,
    external_id: externalId,
    title: offer.title,
    // "#<employee>-<last 8 chars of link>" is always appended
    description: withDescriptionTag((offer.description || "").trim() || (gb.description || "").trim(), employee, offer.link),
    price,
    credentials: [(offer.credentials || "").trim() || MANUAL_PLACEHOLDER],
    image_urls: parseImageUrls(offer.imageUrls || ""),
    account_data: accountData,
    // We only sell manual-delivery offers
    is_manual: true,
    delivery_time: { duration: Number(gb.deliveryDuration), unit: gb.deliveryUnit },
  }
  if (gb.deliveryInstructions?.trim()) payload.delivery_instructions = gb.deliveryInstructions.trim()
  if (gb.dump?.trim()) payload.dump = gb.dump.trim()
  return payload
}

/**
 * Create one offer. Never blindly retried: on an unknown outcome we look it up by external_id.
 * One exception: a 422 (definitely NOT created) where GameBoost only complains about value types
 * ("must be an integer") - those are converted and the create is sent once more.
 */
async function createOnGameBoost(
  payload: CreateOfferPayload,
  listNow: boolean,
  types: Record<string, FieldType>,
  learned: Record<string, FieldType>
): Promise<{ offer: AccountOffer; warning?: string }> {
  let offer: AccountOffer
  try {
    try {
      offer = await createOffer(payload)
    } catch (e) {
      if (!(e instanceof GameBoostError && e.status === 422)) throw e
      const newTypes = typesFromErrors(e.errors)
      if (!Object.keys(newTypes).length) throw e
      Object.assign(learned, newTypes)
      const fixed = coerceAccountData(payload.account_data, { ...types, ...newTypes })
      if (JSON.stringify(fixed) === JSON.stringify(payload.account_data)) throw e // nothing we can convert
      payload = { ...payload, account_data: fixed }
      offer = await createOffer(payload)
    }
  } catch (e) {
    const unknownOutcome = e instanceof GameBoostError && (e.status === 0 || e.status >= 500)
    if (!unknownOutcome) throw e
    // Timeout / 5xx: it may or may not have been created. Check before reporting failure.
    const found = await findOfferByExternalId(payload.external_id!).catch(() => null)
    if (!found) throw e
    offer = found
  }

  let warning: string | undefined
  if (listNow && offer.status !== "listed") {
    try {
      offer = await publishOffer(offer.id)
    } catch (e) {
      warning = `Created as "${offer.status}" but could not list it: ${errorMessage(e)}`
    }
  }
  return { offer, warning }
}

export async function POST(req: Request) {
  const raw = await req.json().catch(() => null)
  const parsed = formSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return NextResponse.json(
      { error: `Invalid form: ${first?.path.join(".")} ${first?.message}`.trim(), issues: parsed.error.issues },
      { status: 400 }
    )
  }
  const { employee, gameboost } = parsed.data
  const types = readTypes(gameboost)
  const learnedTypes: Record<string, FieldType> = {}
  // 1) remove the word-filter words, 2) space after emojis (GameBoost search needs it).
  // The cleaned title is what goes to GameBoost, the sheet and the duplicate check.
  const filterWords = parseFilterWords(gameboost.filterWords)
  const offers = parsed.data.offers.map(o => ({
    ...o,
    title: fixTitle(applyWordFilter(o.title, filterWords)),
    description: applyWordFilter(o.description || "", filterWords, true),
  }))
  gameboost.description = applyWordFilter(gameboost.description || "", filterWords, true)

  // 1. Duplicate check against the sheet (source of truth) and within this batch
  let rows
  try {
    rows = await readRows()
  } catch (err) {
    console.error("POST /api/offers read error:", googleErrorDetails(err))
    return NextResponse.json({ error: sheetErrorMessage(err) }, { status: 500 })
  }

  const existingTitles = new Set(rows.map(r => normalize(r.cells[COL.TITLE] || "")))
  const seenInBatch = new Set<string>()
  const toProcess: OfferValues[] = []
  const duplicateTitles: string[] = []

  for (const offer of offers) {
    const t = normalize(offer.title)
    if (existingTitles.has(t) || seenInBatch.has(t)) {
      duplicateTitles.push(t)
    } else {
      seenInBatch.add(t)
      toProcess.push(offer)
    }
  }

  // 2. Create on GameBoost (one by one: keeps us far below the write limits and makes errors per-offer)
  const now = nowStamp()
  const sheetRows: (string | number)[][] = []
  const failed: Failed[] = []
  const published: Published[] = []

  for (const offer of toProcess) {
    const baseRow = [
      offer.link.trim(),
      offer.price.trim(),
      employee,
      offer.title.trim(),
      offer.note?.trim() || "",
      now,
    ]

    if (offer.title.length < 3) {
      failed.push({ title: normalize(offer.title), error: "Title is empty or too short after the word filter" })
      continue
    }

    if (!gameboost.enabled) {
      sheetRows.push([...baseRow, "", "", "", "", "", ""])
      continue
    }

    const externalId = makeExternalId(employee)
    try {
      const payload = buildPayload(employee, offer, gameboost, externalId, { ...types, ...learnedTypes })
      const { offer: created, warning } = await createOnGameBoost(payload, gameboost.listNow, { ...types, ...learnedTypes }, learnedTypes)
      published.push({ title: normalize(offer.title), id: created.id, status: created.status, warning })
      sheetRows.push([
        ...baseRow,
        created.id,
        created.status,
        created.external_id || externalId,
        created.price ?? payload.price,
        gameboost.gameName || gameboost.gameSlug || String(gameboost.gameId),
        now,
      ])
    } catch (e) {
      console.error(`GameBoost create failed for "${offer.title}":`, errorMessage(e))
      // "account_data.platform is required" -> tell the form which listing details to add
      const missingFields = e instanceof GameBoostError ? requiredFieldsFromErrors(e.errors) : []
      const badFields = e instanceof GameBoostError ? accountDataFieldsFromErrors(e.errors) : []
      if (e instanceof GameBoostError) Object.assign(learnedTypes, typesFromErrors(e.errors))
      failed.push({
        title: normalize(offer.title),
        error: errorMessage(e),
        missingFields: missingFields.length ? missingFields : undefined,
        badFields: badFields.length ? badFields : undefined,
      })
      // An auth problem will fail every offer the same way - stop early
      if (e instanceof GameBoostError && e.status === 401) {
        for (const rest of toProcess.slice(toProcess.indexOf(offer) + 1)) {
          failed.push({ title: normalize(rest.title), error: "Skipped: GameBoost API key was rejected" })
        }
        break
      }
    }
  }

  // 3. Log to the sheet (only what was actually created, so the daily count stays honest)
  if (sheetRows.length) {
    try {
      if (gameboost.enabled) await ensureGameBoostHeaders()
      // Re-read the length right before writing so two people submitting at once don't overwrite each other
      const nextRow = (await readRows()).length + 2
      await writeRowsAt(nextRow, sheetRows)
    } catch (err) {
      console.error("POST /api/offers sheet write error:", googleErrorDetails(err))
      return NextResponse.json(
        {
          error: published.length
            ? `Created ${published.length} offer(s) on GameBoost (ids ${published.map(p => p.id).join(", ")}) but could NOT write them to the sheet. Do not resubmit - add them to the sheet by hand or use Manage offers.`
            : sheetErrorMessage(err),
          published,
          failed,
        },
        { status: 500 }
      )
    }
  }

  return NextResponse.json({
    success: true,
    addedCount: sheetRows.length,
    skippedCount: duplicateTitles.length,
    duplicates: duplicateTitles, // normalized titles
    failedCount: failed.length,
    failed,
    published,
    learnedTypes, // the form remembers these per game
  })
}
