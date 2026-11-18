/**
 * Destination = a marketplace we publish to. GameBoost is the only one for now (Eldorado is parked).
 * A second destination implements this interface; the /auto page and /api/auto/publish don't change.
 */

export type DestGame = { id: number; slug: string; name: string }

export type PublishItem = {
  /** Stable id of the row in the batch (the source lot id, e.g. "funpay:71122224"). */
  ref: string
  link: string
  seller: string
  title: string
  description: string
  images: string[]
  /** As typed by the employee: a number or a multiplier ("x2"). */
  priceInput: string
  /** Source page price, needed for multipliers. */
  sourcePrice?: number
  accountData: Record<string, unknown>
  /** Required fields filled with the lowest value: written to the sheet NOTE. */
  defaulted: string[]
  /** Short extra notes for the sheet (e.g. "album images"). */
  notes?: string[]
  game: DestGame
}

export type PublishSettings = {
  /** false = create as draft (not for sale). */
  listNow: boolean
  deliveryDuration: number
  deliveryUnit: "minutes" | "hours" | "days"
  /** Used for offers with an empty description. */
  defaultDescription?: string
  /** Shown to the buyer after purchase (NOT encrypted: never credentials). */
  deliveryInstructions?: string
}

export type PublishResult = {
  ref: string
  status: "created" | "duplicate" | "failed"
  offerId?: number
  offerStatus?: string
  error?: string
  warning?: string
}

export interface DestinationAdapter {
  id: string
  publish(items: PublishItem[], settings: PublishSettings): Promise<PublishResult[]>
}
