import { googleSheetsApi } from "../state/index"
import { MemoryDefaultImageStore, SheetDefaultImageStore, type DefaultImageStore } from "./defaultImages"

/** Sheet-backed (own DEFAULT_IMG tab) when Google is configured, else in-memory (local dev only). Server only. */
export function getDefaultImageStore(env: Record<string, string | undefined> = process.env): DefaultImageStore {
  const g = globalThis as unknown as { __lsDefImg?: DefaultImageStore }
  if (g.__lsDefImg) return g.__lsDefImg
  const id = env.GOOGLE_SHEET_ID?.trim()
  const ok = id && env.GOOGLE_CLIENT_EMAIL?.trim() && env.GOOGLE_PRIVATE_KEY?.trim()
  g.__lsDefImg = ok ? new SheetDefaultImageStore(googleSheetsApi(id!), env.DEFAULT_IMG_TAB?.trim() || "DEFAULT_IMG") : new MemoryDefaultImageStore()
  return g.__lsDefImg
}
