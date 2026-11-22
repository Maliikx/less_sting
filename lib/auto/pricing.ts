/**
 * Price rounding for GameBoost (user decision): from 150 up, round UP to the next multiple of 5
 * (1223.22 -> 1225, 324 -> 325, 556 -> 560). Under 150: unchanged. Client-safe (no server imports).
 */
export const ROUND_FROM = 150
export const ROUND_STEP = 5

export type Rounded = { value: number; rounded: boolean; original: number }

export function roundPrice(price: number): Rounded {
  const v = Math.round(price * 100) / 100
  if (!Number.isFinite(v) || v < ROUND_FROM) return { value: v, rounded: false, original: v }
  const up = Math.ceil(v / ROUND_STEP - 1e-9) * ROUND_STEP
  return { value: up, rounded: up !== v, original: v }
}

const money = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))
export const roundingMessage = (r: Rounded) => `Price rounded up ${money(r.original)} → ${money(r.value)} (prices from ${ROUND_FROM} round up to the next ${ROUND_STEP})`
export const roundingNote = (r: Rounded, input: string) => `price rounded ${money(r.original)} → ${money(r.value)} (input ${input})`
