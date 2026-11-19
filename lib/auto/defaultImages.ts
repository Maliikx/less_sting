import { listingProblems } from "../offerRules"
import { ensureOwnTab, quoteTab } from "../state/ownTab"
import type { SheetsApi } from "../state/sheetStore"

/**
 * Default image per GameBoost game, used when an offer has no images at all (user decision).
 * Kept in the sheet's OWN tab `DEFAULT_IMG` (env DEFAULT_IMG_TAB):  GAME_ID | GAME_NAME | IMAGE_URL | UPDATED_AT
 * The app creates that tab, only reads/writes inside it and refuses a same-named tab it did not create.
 * The sheet stores the image LINK (GameBoost takes image URLs; a sheet cell cannot hold a usable image file).
 */

export const DEFAULT_IMG_HEADERS = ["GAME_ID", "GAME_NAME", "IMAGE_URL", "UPDATED_AT"]

export type DefaultImage = { gameId: number; gameName: string; url: string; updatedAt?: string }

export interface DefaultImageStore {
  all(): Promise<Map<number, DefaultImage>>
  set(img: DefaultImage): Promise<void>
}

/** Problem with a default image link, or null. Same rules GameBoost applies to listing images (no imgur, http(s)). */
export function defaultImageProblem(url: string): string | null {
  const u = String(url || "").trim()
  if (!/^https:\/\/\S+$/i.test(u)) return "Use a full https:// image link"
  const p = listingProblems({ imageUrls: [u] })
  return p.length ? p.join("; ") : null
}

export class MemoryDefaultImageStore implements DefaultImageStore {
  private m = new Map<number, DefaultImage>()
  async all() {
    return new Map(this.m)
  }
  async set(img: DefaultImage) {
    this.m.set(img.gameId, { ...img })
  }
}

export class SheetDefaultImageStore implements DefaultImageStore {
  private ready: Promise<void> | null = null
  constructor(private api: SheetsApi, private tab = "DEFAULT_IMG", private stamp: () => string = () => new Date().toISOString()) {}

  private range = (a1: string) => `${quoteTab(this.tab)}!${a1}`
  private ensure() {
    if (!this.ready) {
      this.ready = ensureOwnTab(this.api, this.tab, DEFAULT_IMG_HEADERS, "Set DEFAULT_IMG_TAB to another name.").catch(e => {
        this.ready = null
        throw e
      })
    }
    return this.ready
  }

  private async rows() {
    await this.ensure()
    const values = await this.api.getValues(this.range("A2:D"))
    return values.map((r, i) => ({ rowNumber: i + 2, gameId: Number(r[0]), gameName: String(r[1] ?? ""), url: String(r[2] ?? "").trim(), updatedAt: String(r[3] ?? "") }))
  }

  async all() {
    const m = new Map<number, DefaultImage>()
    for (const r of await this.rows()) {
      if (Number.isInteger(r.gameId) && r.gameId > 0 && r.url && !defaultImageProblem(r.url)) m.set(r.gameId, r) // later rows win
    }
    return m
  }

  async set(img: DefaultImage) {
    const rows = await this.rows()
    const row = [img.gameId, img.gameName, img.url.trim(), this.stamp()]
    const existing = rows.filter(r => r.gameId === img.gameId).pop()
    if (existing) await this.api.batchUpdate([{ range: this.range(`A${existing.rowNumber}:D${existing.rowNumber}`), values: [row] }])
    else await this.api.append(this.range("A:D"), [row])
  }
}
