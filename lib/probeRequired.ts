import { createOffer, deleteOffer, GameBoostError } from "./gameboost"
import { accountDataFieldsFromErrors } from "./template"

/**
 * Finds out which listing details GameBoost requires for a game (the template doesn't say).
 * Sends a create request that is GUARANTEED to be rejected (price 0, empty title, no images, no credentials)
 * and reads GameBoost's validation errors. Nothing can be created: the minimum price is 0.99. As a last
 * safety net, if anything were ever created it is deleted immediately.
 */
export type ProbeResult = { fields: string[]; requiredFields: string[]; messages: Record<string, string> }

async function probeOnce(gameId: number, accountData: Record<string, unknown>): Promise<ProbeResult> {
  try {
    const created = await createOffer({
      game_id: gameId,
      title: "",
      description: "",
      price: 0,
      credentials: [],
      image_urls: [],
      account_data: accountData,
      is_manual: true,
      delivery_time: { duration: 1, unit: "hours" },
    })
    if (created?.id) await deleteOffer(created.id).catch(() => {})
    return { fields: [], requiredFields: [], messages: {} }
  } catch (e) {
    if (!(e instanceof GameBoostError) || e.status !== 422) throw e
    const errors = (e.errors || {}) as Record<string, unknown>
    const messages: Record<string, string> = {}
    for (const [k, v] of Object.entries(errors)) {
      const m = k.match(/^account_data\.([^.]+)/)
      if (m) messages[m[1]] = Array.isArray(v) ? v.join(" ") : String(v)
    }
    const fields = accountDataFieldsFromErrors(errors)
    const typeOnly = /must be (an integer|a number|numeric|a boolean|true or false|an array|a string)/i
    const requiredFields = fields.filter(f => {
      const m = messages[f] || "required"
      return !typeOnly.test(m) && /required|must|invalid|selected/i.test(m)
    })
    return { fields, requiredFields, messages }
  }
}

export async function probeRequired(gameId: number): Promise<ProbeResult> {
  let r = await probeOnce(gameId, {})
  if (!r.fields.length) {
    const r2 = await probeOnce(gameId, { _probe: "1" })
    if (r2.fields.length) r = { ...r2, fields: r2.fields.filter(f => f !== "_probe"), requiredFields: r2.requiredFields.filter(f => f !== "_probe") }
  }
  return r
}
