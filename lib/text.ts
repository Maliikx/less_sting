import { fixTitle } from "./offerRules"

/** Same normalisation as lib/sheets.ts `normalize` (POST /api/offers' duplicate-title check). Client-safe. */
export const normalize = (value: string) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ")

/** Title key for duplicate checks: spacing after emojis fixed (as titles are listed), then normalized. */
export const titleKey = (title: string) => normalize(fixTitle(title))
