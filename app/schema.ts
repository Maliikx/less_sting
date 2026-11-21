import { z } from "zod"
import {
  DELIVERY_UNITS,
  applyWordFilter,
  fixTitle,
  parseFilterWords,
  listingProblems,
  parseImageUrls,
  parseJsonObject,
  resolvePrice,
} from "@/lib/offerRules"

export const offerSchema = z.object({
  title: z.string().min(3, "Title is required"),
  link: z.string().url("Invalid URL"),
  price: z.string().min(1, "Price is required"),
  note: z.string().optional(),

  /* ---- GameBoost-only fields (ignored when publishing is off) ---- */
  /** Used when PRICE is a multiplier like "x2.2": EUR price = sourcePrice x 2.2 */
  sourcePrice: z.string().optional(),
  /** One URL per line. First image must show the account (not a logo). No imgur. */
  imageUrls: z.string().optional(),
  /** Overrides the batch description for this offer. */
  description: z.string().optional(),
  /** Optional account details (JSON) merged over the batch account data, e.g. {"level": 30} */
  accountData: z.string().optional(),
  /** Optional. Manual delivery: leave empty to use the server placeholder text. */
  credentials: z.string().optional(),
})

export const gameboostSchema = z.object({
  enabled: z.boolean(),
  gameId: z.number().optional(),
  gameSlug: z.string().optional(),
  gameName: z.string().optional(),
  deliveryDuration: z.string().optional(),
  deliveryUnit: z.enum(DELIVERY_UNITS),
  description: z.string().optional(),
  accountData: z.string().optional(),
  deliveryInstructions: z.string().optional(),
  dump: z.string().optional(),
  /** Words/phrases removed from every title and description (one per line or comma separated) */
  filterWords: z.string().optional(),
  /** Listing-detail fields that must be filled (comma separated), from the template or GameBoost errors */
  requiredFields: z.string().optional(),
  /** Learned value type per listing-detail field, JSON {"apex_coins_count":"integer"} */
  fieldTypes: z.string().optional(),
  listNow: z.boolean(),
})

export const formSchema = z
  .object({
    employee: z.string().min(1, "Employee is required"),
    offers: z.array(offerSchema).min(1, "At least one offer is required"),
    gameboost: gameboostSchema,
  })
  .superRefine((v, ctx) => {
    const gb = v.gameboost
    const words = parseFilterWords(gb.filterWords)
    v.offers.forEach((o, i) => {
      if (words.length && !applyWordFilter(o.title, words).trim()) {
        ctx.addIssue({ code: "custom", path: ["offers", i, "title"], message: "Nothing is left of this title after the word filter" })
      }
    })
    if (!gb.enabled) return

    if (!gb.gameId) {
      ctx.addIssue({ code: "custom", path: ["gameboost", "gameId"], message: "Pick the game" })
    }
    const dur = Number(gb.deliveryDuration)
    if (!Number.isInteger(dur) || dur <= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["gameboost", "deliveryDuration"],
        message: "Manual delivery needs a delivery time (whole number)",
      })
    }
    const batchData = parseJsonObject(gb.accountData, "Account data")
    if (batchData.error) {
      ctx.addIssue({ code: "custom", path: ["gameboost", "accountData"], message: batchData.error })
    }
    // Required listing details must be filled for every offer (its own value, or the default)
    const required = (gb.requiredFields || "").split(",").map(s => s.trim()).filter(Boolean)
    if (required.length && batchData.value) {
      const isEmpty = (x: unknown) => x === undefined || x === null || (typeof x === "string" && !x.trim()) || (Array.isArray(x) && !x.length)
      const nice = (k: string) => k.replace(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase())
      v.offers.forEach((o, i) => {
        const merged = { ...batchData.value, ...(parseJsonObject(o.accountData, "Account data").value || {}) }
        const missing = required.filter(k => isEmpty(merged[k]))
        if (missing.length) {
          ctx.addIssue({ code: "custom", path: ["offers", i, "accountData"], message: `Fill in: ${missing.map(nice).join(", ")}` })
        }
      })
    }
    if ((gb.deliveryInstructions || "").length > 2048) {
      ctx.addIssue({ code: "custom", path: ["gameboost", "deliveryInstructions"], message: "Max 2048 characters" })
    }

    v.offers.forEach((o, i) => {
      const price = resolvePrice(o.price, o.sourcePrice)
      if (price.error) ctx.addIssue({ code: "custom", path: ["offers", i, "price"], message: price.error })

      const description = applyWordFilter((o.description || "").trim() || (gb.description || "").trim(), words, true)
      if (!description) {
        ctx.addIssue({
          code: "custom",
          path: ["offers", i, "description"],
          message: "Add a description here or a default description above",
        })
      }

      const own = parseJsonObject(o.accountData, "Account data")
      if (own.error) ctx.addIssue({ code: "custom", path: ["offers", i, "accountData"], message: own.error })

      const images = parseImageUrls(o.imageUrls || "")
      const imgProblems = listingProblems({ imageUrls: images })
      if (imgProblems.length) {
        ctx.addIssue({ code: "custom", path: ["offers", i, "imageUrls"], message: imgProblems.join("; ") })
      }

      const textProblems = listingProblems({ title: fixTitle(applyWordFilter(o.title, words)), description, dump: gb.dump })
      if (textProblems.length) {
        ctx.addIssue({ code: "custom", path: ["offers", i, "title"], message: textProblems.join("; ") })
      }

      if ((o.credentials || "").length > 500) {
        ctx.addIssue({ code: "custom", path: ["offers", i, "credentials"], message: "Max 500 characters" })
      }
    })
  })

export type FormValues = z.infer<typeof formSchema>
export type OfferValues = z.infer<typeof offerSchema>
export type GameBoostSettings = z.infer<typeof gameboostSchema>
