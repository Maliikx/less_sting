/**
 * The message sent as the offer's "credentials" (manual delivery: the buyer receives it after purchase).
 * Editable on /auto; `[delivery time]` is replaced with the delivery time setting ("1 hour", "30 minutes", "2 days").
 */
export const DEFAULT_CREDENTIALS_TEMPLATE = "thank you for your purchase\n\ndelivery takes anywhere from 5 min up to [delivery time] ❤️"
export const CREDENTIALS_MAX = 500 // GameBoost / app/schema.ts limit

/** 1 + "hours" -> "1 hour", 30 + "minutes" -> "30 minutes". */
export function formatDelivery(duration: number, unit: "minutes" | "hours" | "days") {
  const word = duration === 1 ? unit.replace(/s$/, "") : unit
  return `${duration} ${word}`
}

/** Fill the placeholder (also tolerates spelling/spacing variants like "[delivary time]" or "[Delivery Time]"). */
export function renderCredentials(template: string, duration: number, unit: "minutes" | "hours" | "days") {
  return String(template || "").replace(/\[\s*deliv[a-z]*\s*time\s*\]/gi, formatDelivery(duration, unit)).trim()
}
