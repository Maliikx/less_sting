/**
 * Minimal GameBoost API v2 client (server side only — the API key never reaches the browser).
 *
 * Docs: https://docs.gameboost.com  (Bearer auth, JSON, rate limits per key:
 *   reads 1000/min, writes 500/min, and max 5/min + 10/hour writes to the SAME offer).
 */

const BASE = (process.env.GAMEBOOST_API_BASE || "https://api.gameboost.com/v2").replace(/\/+$/, "")

export type OfferStatus =
  | "draft"
  | "pending"
  | "listed"
  | "processing"
  | "sold"
  | "refunded"
  | "archived"
  | string

export type DeliveryUnit = "minutes" | "hours" | "days"

export type AccountOffer = {
  id: number
  external_id?: string | null
  game?: { id: number; name: string; slug: string } | null
  account_order_ids?: number[]
  title: string
  slug?: string
  description?: string
  parameters?: unknown
  dump?: string | null
  status: OfferStatus
  delivery_time?: { duration: number; unit: DeliveryUnit; format?: string; format_long?: string; seconds?: number } | null
  is_manual_delivery?: boolean
  credentials?: unknown
  delivery_instructions?: string | null
  private_note?: string | null
  /** EUR as a plain decimal string, e.g. "10.99" (normalized by normalizeOffer) */
  price: string
  /** Display text from GameBoost, e.g. "€10.99" */
  price_display?: string
  price_usd?: string
  views?: number
  image_urls?: string[]
  created_at?: number
  updated_at?: number
  listed_at?: number | null
}

export type CreateOfferPayload = {
  game_id?: number
  game?: string
  external_id?: string
  title: string
  description: string
  price: number
  credentials: string[]
  image_urls: string[]
  account_data: Record<string, unknown>
  dump?: string
  private_note?: string
  is_manual: boolean
  delivery_time?: { duration: number; unit: DeliveryUnit }
  delivery_instructions?: string
  game_items?: Record<string, string[]>
}

export type UpdateOfferPayload = Partial<
  Pick<
    CreateOfferPayload,
    | "title"
    | "description"
    | "price"
    | "image_urls"
    | "account_data"
    | "dump"
    | "private_note"
    | "is_manual"
    | "delivery_time"
    | "delivery_instructions"
    | "game_items"
    | "external_id"
  >
>

export type Paginated<T> = {
  data: T[]
  meta?: { current_page?: number; last_page?: number; per_page?: number; total?: number; from?: number; to?: number }
  links?: { first?: string | null; last?: string | null; prev?: string | null; next?: string | null }
}

export class GameBoostError extends Error {
  status: number // 0 = network error / timeout (outcome unknown)
  errors?: unknown
  requestId?: string

  constructor(status: number, message: string, errors?: unknown, requestId?: string) {
    super(message)
    this.status = status
    this.errors = errors
    this.requestId = requestId
  }

  /** Human readable, including field errors (docs show both "string" and ["string"] forms). */
  get details() {
    const parts: string[] = [this.message]
    if (this.errors && typeof this.errors === "object") {
      for (const [field, msg] of Object.entries(this.errors as Record<string, unknown>)) {
        parts.push(`${field}: ${Array.isArray(msg) ? msg.join(", ") : String(msg)}`)
      }
    }
    if (this.requestId) parts.push(`request_id ${this.requestId}`)
    return parts.join(" | ")
  }
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))

type RequestOptions = {
  body?: unknown
  query?: Record<string, string | number | undefined>
  /** Retry 5xx / network errors. Off for create: it is not documented as idempotent. */
  retryServerErrors?: boolean
}

async function request<T>(method: string, pathOrUrl: string, opts: RequestOptions = {}): Promise<T> {
  const key = process.env.GAMEBOOST_API_KEY
  if (!key) throw new GameBoostError(500, "GAMEBOOST_API_KEY is not set on the server")

  const url = new URL(pathOrUrl.startsWith("http") ? pathOrUrl : BASE + pathOrUrl)
  if (!url.href.startsWith(BASE)) throw new GameBoostError(400, "Refusing to call a non-GameBoost URL")
  for (const [k, v] of Object.entries(opts.query || {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v))
  }

  const retry5xx = opts.retryServerErrors ?? true
  const maxAttempts = 4
  let delay = 1000

  for (let attempt = 1; ; attempt++) {
    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(25_000),
      })
    } catch (e) {
      if (retry5xx && attempt < maxAttempts) {
        await sleep(delay + Math.random() * 300)
        delay = Math.min(delay * 2, 15_000)
        continue
      }
      throw new GameBoostError(0, `Network error talking to GameBoost: ${e instanceof Error ? e.message : String(e)}`)
    }

    const requestId = res.headers.get("x-gameboost-request-id") || undefined

    // 429 is always safe to retry: the request was rejected before doing anything.
    if ((res.status === 429 || (res.status >= 500 && retry5xx)) && attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get("retry-after"))
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delay
      if (wait > 20_000) {
        // Too long to hold a web request open; tell the user instead.
        throw new GameBoostError(429, `GameBoost rate limit hit, try again in ${Math.ceil(wait / 1000)}s`, undefined, requestId)
      }
      await sleep(wait + Math.random() * 300)
      delay = Math.min(delay * 2, 15_000)
      continue
    }

    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      /* non-JSON body */
    }

    if (res.ok) return json as T

    const j = (json || {}) as { message?: string; errors?: unknown; request_id?: string }
    const fallback =
      res.status === 401
        ? "GameBoost rejected the API key (401). Check GAMEBOOST_API_KEY."
        : res.status === 403
          ? "GameBoost says this offer is not yours or the key lacks permission (403)."
          : res.status === 404
            ? "Not found on GameBoost (404)."
            : res.status === 429
              ? "GameBoost rate limit hit. Each offer can only be changed 5x/minute and 10x/hour."
              : `GameBoost error ${res.status}`
    throw new GameBoostError(res.status, j.message || fallback, j.errors, j.request_id || requestId)
  }
}

/* ------------------------------------------------------------------ money */

type MoneyObject = { format?: unknown; value?: unknown; amount?: unknown; currency?: unknown }

const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[^\d.,-]/g, "").replace(",", "."))
  return Number.isFinite(n) ? n : undefined
}

/**
 * The live API returns money as an object { format, value, amount, currency }
 * (the docs say a plain string). Turn either shape into a plain decimal string.
 * `format` (e.g. "€10.99") is used to tell which of value/amount is the decimal price.
 */
export function moneyToString(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (typeof v !== "object") return String(v)
  const m = v as MoneyObject
  const shown = typeof m.format === "string" ? num(m.format) : undefined
  const value = num(m.value)
  const amount = num(m.amount)
  const candidates = [value, amount, amount !== undefined ? amount / 100 : undefined, value !== undefined ? value / 100 : undefined]
  if (shown !== undefined) {
    const match = candidates.find(c => c !== undefined && Math.abs(c - shown) < 0.005)
    if (match !== undefined) return match.toFixed(2)
    return shown.toFixed(2)
  }
  const first = value ?? amount
  return first !== undefined ? first.toFixed(2) : ""
}

function moneyDisplay(v: unknown) {
  if (v && typeof v === "object" && typeof (v as MoneyObject).format === "string") return (v as MoneyObject).format as string
  const s = moneyToString(v)
  return s ? `€${s}` : ""
}

/** Make every offer coming back from the API safe to store and render. */
export function normalizeOffer(o: AccountOffer): AccountOffer {
  if (!o || typeof o !== "object") return o
  const raw = o as AccountOffer & { price: unknown; price_usd?: unknown }
  return {
    ...o,
    price: moneyToString(raw.price),
    price_display: moneyDisplay(raw.price),
    price_usd: raw.price_usd === undefined ? undefined : moneyToString(raw.price_usd),
  }
}

/* ------------------------------------------------------------------ games */

export type Game = { id: number; name: string; slug: string }

export async function listGames(search?: string) {
  const res = await request<Paginated<Game>>("GET", "/games", {
    query: { "filter[search]": search, per_page: 50 },
  })
  return res.data || []
}

/** Per-game template: shows the account_data / game_items shape a create call needs. */
export async function getTemplate(gameSlug: string) {
  return request<unknown>("GET", `/account-offers/templates/${encodeURIComponent(gameSlug)}`)
}

/* ------------------------------------------------------------------ offers */

export async function listOffers(params: {
  search?: string
  status?: string
  ids?: (number | string)[]
  externalIds?: string[]
  perPage?: number
  sort?: string
  /** A `links.next` / `links.prev` URL returned by a previous call. */
  pageUrl?: string
}) {
  const page = params.pageUrl
    ? await request<Paginated<AccountOffer>>("GET", params.pageUrl)
    : await request<Paginated<AccountOffer>>("GET", "/account-offers", {
    query: {
      "filter[search]": params.search,
      "filter[status]": params.status,
      "filter[id]": params.ids?.join(","),
      "filter[external_id]": params.externalIds?.join(","),
      per_page: params.perPage ?? 50,
      sort: params.sort,
    },
  })
  return { ...page, data: (page.data || []).map(normalizeOffer) }
}

export async function getOffer(id: number | string) {
  const res = await request<{ data: AccountOffer }>("GET", `/account-offers/${encodeURIComponent(String(id))}`)
  return normalizeOffer(res.data)
}

export async function findOfferByExternalId(externalId: string) {
  const res = await listOffers({ externalIds: [externalId], perPage: 1 })
  return res.data?.[0] || null
}

export async function createOffer(payload: CreateOfferPayload) {
  const res = await request<{ data: AccountOffer }>("POST", "/account-offers/create", {
    body: payload,
    retryServerErrors: false,
  })
  return normalizeOffer(res.data)
}

export async function updateOffer(id: number | string, changes: UpdateOfferPayload) {
  const res = await request<{ data: AccountOffer }>("PATCH", `/account-offers/${encodeURIComponent(String(id))}`, {
    body: changes,
  })
  return normalizeOffer(res.data)
}

/** Permanent. Cannot be undone. */
export async function deleteOffer(id: number | string) {
  await request<unknown>("DELETE", `/account-offers/${encodeURIComponent(String(id))}`)
}

export async function publishOffer(id: number | string) {
  const res = await request<{ data: AccountOffer }>("POST", `/account-offers/${encodeURIComponent(String(id))}/list`)
  return normalizeOffer(res.data)
}

/** "Unlist": moves the offer back to draft (reversible). */
export async function unlistOffer(id: number | string) {
  const res = await request<{ data: AccountOffer }>("POST", `/account-offers/${encodeURIComponent(String(id))}/draft`)
  return normalizeOffer(res.data)
}

/** Offers come back WITH credentials. Strip them before anything goes to the browser. */
export function publicOffer(o: AccountOffer) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { credentials, ...rest } = o
  return rest
}

export function errorMessage(e: unknown) {
  if (e instanceof GameBoostError) return e.details
  return e instanceof Error ? e.message : String(e)
}
