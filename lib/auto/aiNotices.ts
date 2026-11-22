/**
 * Turn the AI models' state (returned by /api/ai/prepare) into toast notifications, each shown ONCE:
 *  - one per model that ran out of tokens for today (or hit our daily budget, or a per-minute limit)
 *  - one when EVERY model in the chain is out (offers that need AI are then marked "check")
 * Client-safe and pure: `seen` holds the keys already shown.
 */
export type AiUsageLite = { entry: string; tokensToday: number; cooldownSeconds: number; limit?: "daily" | "minute" | "budget" | "error" }
export type Notice = { key: string; tone: "warn" | "error"; title: string; body: string }

const waitText = (s: number) => {
  if (s >= 3600) return `about ${Math.round(s / 3600)} h`
  if (s >= 60) return `about ${Math.round(s / 60)} min`
  return `${s} s`
}
const modelName = (entry: string) => entry.replace(/^[^:]+:/, "")

export function aiLimitNotices(usage: AiUsageLite[], seen: Set<string>, day: string): Notice[] {
  const out: Notice[] = []
  const limited = usage.filter(u => u.limit && (u.cooldownSeconds > 0 || u.limit === "budget"))
  for (const u of limited) {
    // per-minute limits pass quickly: notify only for the long ones
    if (u.limit === "minute" && u.cooldownSeconds < 120) continue
    const key = `${day}:${u.entry}:${u.limit}`
    if (seen.has(key)) continue
    const name = modelName(u.entry)
    const body =
      u.limit === "daily"
        ? `It used its free tokens for today; it is back in ${waitText(u.cooldownSeconds)}. The next model in the list is used meanwhile.`
        : u.limit === "budget"
          ? "It reached the daily token budget set in AI_DAILY_TOKEN_BUDGET. The next model in the list is used meanwhile."
          : u.limit === "error"
            ? `Its server is failing; trying again in ${waitText(u.cooldownSeconds)}. The next model is used meanwhile.`
            : `It is rate-limited; back in ${waitText(u.cooldownSeconds)}. The next model is used meanwhile.`
    out.push({ key, tone: "warn", title: `AI model out: ${name}`, body })
  }
  if (usage.length > 0 && limited.length === usage.length) {
    const key = `${day}:all`
    if (!seen.has(key)) {
      const back = Math.min(...limited.map(u => (u.limit === "budget" ? Infinity : u.cooldownSeconds)))
      out.push({
        key,
        tone: "error",
        title: `All ${usage.length} AI models are out of tokens`,
        body:
          "Offers that need the AI (translation, missing game details, seller talk) are marked “check” until a model is back" +
          (Number.isFinite(back) ? ` (first one in ${waitText(back)}).` : " (tomorrow)."),
      })
    }
  }
  return out
}
