"use client"
import {
  Card,
  CardDescription,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

import { useForm, useFieldArray } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import { formSchema, FormValues, type GameBoostSettings } from "./schema"
import { Textarea } from "@/components/ui/textarea"
import GameBoostPanel from "./gameboostPanel"
import AccountDataFields from "./accountDataFields"
import NavBar from "./navBar"
import { applyWordFilter, fixTitle, isMultiplier, parseFilterWords, resolvePrice } from "@/lib/offerRules"

// Helper to match backend normalization exactly
const normalize = (val: string) => val.trim().toLowerCase().replace(/\s+/g, " ");

const emptyOffer = (price = "") => ({
  title: "",
  link: "",
  price,
  note: "",
  sourcePrice: "",
  imageUrls: "",
  description: "",
  accountData: "",
  credentials: "",
})

const defaultGameBoost: GameBoostSettings = {
  enabled: true,
  gameId: undefined,
  gameSlug: "",
  gameName: "",
  deliveryDuration: "1",
  deliveryUnit: "hours",
  description: "",
  accountData: "",
  deliveryInstructions: "",
  dump: "",
  filterWords: "",
  requiredFields: "",
  fieldTypes: "",
  listNow: true,
}

// Batch settings are remembered per browser so employees don't re-pick the game every time
const SETTINGS_KEY = "ls_gameboost_settings_v1"

const ListingForm = () => {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null)
  const [submitWarning, setSubmitWarning] = useState<string | null>(null)

  // Initialized to 0 to prevent "NaN"
  const [dailyCount, setDailyCount] = useState<number>(0)
  const [loadingCount, setLoadingCount] = useState(false)
  const [countError, setCountError] = useState<string | null>(null)
  const [duplicateTitles, setDuplicateTitles] = useState<Record<number, boolean>>({})
  // GameBoost errors per offer index (kept in the form so they can be fixed and resubmitted)
  const [gbErrors, setGbErrors] = useState<Record<number, string>>({})

  // Bulk price input at the top of the form
  const [bulkPrice, setBulkPrice] = useState("")

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: "onChange",
    defaultValues: {
      employee: "",
      offers: [emptyOffer()],
      gameboost: defaultGameBoost,
    },
  })

  const { control, handleSubmit, watch, reset, setValue, getValues } = form
  const selectedEmployee = watch("employee")
  const gbEnabled = watch("gameboost.enabled")
  const { fields, append, remove } = useFieldArray({ control, name: "offers" })

  /* ------------------ REMEMBER BATCH SETTINGS ------------------ */
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null")
      if (saved && typeof saved === "object") {
        setValue("gameboost", { ...defaultGameBoost, ...saved })
      }
    } catch { /* storage unavailable */ }
    const sub = watch((values, { name }) => {
      if (!name?.startsWith("gameboost")) return
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(values.gameboost)) } catch { /* ignore */ }
    })
    return () => sub.unsubscribe()
  }, [setValue, watch])

  /* ------------------ DAILY COUNT (always re-read from the sheet) ------------------ */
  const fetchDailyCount = useCallback(async (employee: string) => {
    if (!employee) return
    setLoadingCount(true)
    try {
      const res = await fetch(`/api/offers/count?employee=${encodeURIComponent(employee)}`)
      const data = await res.json()
      setDailyCount(Number(data.count) || 0)
      setCountError(res.ok ? null : data.error || `Could not read the sheet (error ${res.status})`)
    } catch {
      setDailyCount(0)
      setCountError("Could not reach the server")
    } finally {
      setLoadingCount(false)
    }
  }, [])

  useEffect(() => {
    if (!selectedEmployee) return
    fetchDailyCount(selectedEmployee)
  }, [selectedEmployee, fetchDailyCount])

  /* ------------------ LIVE DUPLICATE UI CHECK ------------------ */
  // Keyed on the titles text, not the offers array: the array is a new object on every
  // render, which made the old version hit the Google Sheets API in an endless loop.
  const watchedOffers = watch("offers")
  const filterWords = parseFilterWords(watch("gameboost.filterWords"))
  // The title exactly as it will be listed: filter words removed, space after emojis
  const cleanTitle = (t: string) => fixTitle(applyWordFilter(t || "", filterWords))
  const titlesKey = watchedOffers.map(o => normalize(cleanTitle(o.title || ""))).join("\n")
  useEffect(() => {
    const all = titlesKey.split("\n")
    const titles = all.filter(Boolean)
    if (!titles.length) {
      setDuplicateTitles({});
      return;
    }

    const timeout = setTimeout(async () => {
      try {
        const res = await fetch("/api/offers/check-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ titles }),
        })
        const data = await res.json()
        const dupes: string[] = data.duplicates || []
        const map: Record<number, boolean> = {}
        // A title only counts as a duplicate from its 2nd occurrence in the form (or if it's on the sheet)
        const seen = new Set<string>()
        all.forEach((t, i) => {
          if (!t) return
          const repeated = seen.has(t)
          seen.add(t)
          map[i] = repeated || (dupes.includes(t) && dupes.filter(d => d === t).length >= (all.filter(x => x === t).length))
        })
        setDuplicateTitles(map)
      } catch (e) { console.error("Check failed", e) }
    }, 400)

    return () => clearTimeout(timeout)
  }, [titlesKey])

  /* ------------------ LISTING DETAILS (shared with the panel) ------------------ */
  const [gbTemplate, setGbTemplate] = useState<Record<string, unknown> | null>(null)
  const [gbHints, setGbHints] = useState<Record<string, string>>({})
  const onTemplate = useCallback((t: Record<string, unknown> | null, h: Record<string, string>) => {
    setGbTemplate(t)
    setGbHints(h)
  }, [])
  const gameSlug = watch("gameboost.gameSlug")
  const defaultsJson = watch("gameboost.accountData") || ""
  const requiredJoined = watch("gameboost.requiredFields") || ""
  const typesJson = watch("gameboost.fieldTypes") || ""
  const defaultsObj = useMemo(() => { try { const v = JSON.parse(defaultsJson || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {} } catch { return {} } }, [defaultsJson])
  const requiredList = useMemo(() => requiredJoined.split(",").map(x => x.trim()).filter(Boolean), [requiredJoined])
  const typesObj = useMemo(() => { try { return JSON.parse(typesJson || "{}") || {} } catch { return {} } }, [typesJson])

  /* ------------------ AUTO IMAGES FROM THE OFFER LINK ------------------ */
  // When a link is pasted, the server opens it, grabs the account's images and fills
  // "Image URLs" (only if that box is still empty). It also warns about dead offers.
  type LinkInfo = { state: "loading" | "ok" | "none" | "not_found" | "error"; count?: number; message?: string; price?: number; priceText?: string }
  const [linkInfo, setLinkInfo] = useState<Record<string, LinkInfo>>({})
  const linkCache = useRef(new Set<string>())
  const linksKey = watchedOffers.map(o => (o.link || "").trim()).join("\n")

  useEffect(() => {
    if (!gbEnabled) return
    const timer = setTimeout(() => {
      const uniqueLinks: string[] = Array.from(new Set<string>(linksKey.split("\n")))
      for (const link of uniqueLinks) {
        if (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(link) || linkCache.current.has(link)) continue
        linkCache.current.add(link)
        setLinkInfo(m => ({ ...m, [link]: { state: "loading" } }))
        fetch(`/api/source/preview?url=${encodeURIComponent(link)}`)
          .then(r => r.json())
          .then((res: { status: string; images?: string[]; message?: string; price?: number; priceText?: string }) => {
            const images = res.images || []
            let filled = 0
            // Price on the page -> "Source price" (used when the price box holds a multiplier like x2)
            if (res.status === "ok" && res.price) {
              ;(getValues("offers") || []).forEach((o, i) => {
                if ((o.link || "").trim() === link && !(o.sourcePrice || "").trim()) {
                  setValue(`offers.${i}.sourcePrice`, String(res.price), { shouldValidate: true })
                }
              })
              // re-validate prices that are multipliers
              ;(getValues("offers") || []).forEach((o, i) => {
                if ((o.link || "").trim() === link) setValue(`offers.${i}.price`, o.price, { shouldValidate: true })
              })
            }
            if (res.status === "ok" && images.length) {
              ;(getValues("offers") || []).forEach((o, i) => {
                if ((o.link || "").trim() === link && !(o.imageUrls || "").trim()) {
                  setValue(`offers.${i}.imageUrls`, images.join("\n"), { shouldValidate: true })
                  filled++
                }
              })
            }
            setLinkInfo(m => ({
              ...m,
              [link]:
                res.status === "not_found" ? { state: "not_found", message: res.message }
                : res.status === "error" ? { state: "error", message: res.message }
                : images.length ? { state: "ok", count: filled ? images.length : 0, price: res.price, priceText: res.priceText }
                : { state: "none", price: res.price, priceText: res.priceText },
            }))
          })
          .catch(() => {
            linkCache.current.delete(link)
            setLinkInfo(m => ({ ...m, [link]: { state: "error", message: "Could not reach the server" } }))
          })
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [linksKey, gbEnabled, getValues, setValue])

  /* ------------------ BULK ACTIONS ------------------ */
  const addTenOffers = () => {
    append(Array.from({ length: 10 }, () => emptyOffer(bulkPrice.trim())))
  }

  const applyPriceToAll = () => {
    const price = bulkPrice.trim()
    if (!price) return
    fields.forEach((_, i) => {
      setValue(`offers.${i}.price`, price, { shouldValidate: true, shouldDirty: true })
    })
  }

  /* ------------------ SUBMIT ------------------ */
  const onSubmit = async (rawValues: FormValues) => {
    // Emojis get a space after them automatically (GameBoost search ignores glued keywords)
    const values: FormValues = { ...rawValues, offers: rawValues.offers.map(o => ({ ...o, title: cleanTitle(o.title) })) }
    try {
      setIsSubmitting(true)
      setSubmitError(null)
      setSubmitSuccess(null)
      setSubmitWarning(null)
      setGbErrors({})

      const res = await fetch("/api/offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      })

      const data = await res.json()

      // Handle server error response
      if (!res.ok) {
        setSubmitError(data.error || "❌ Something went wrong.")
        if (res.status === 401) window.location.href = "/login"
        return
      }

      const added = data.addedCount ?? 0;
      const skipped = data.skippedCount ?? 0;
      const failedList: { title: string; error: string; missingFields?: string[]; badFields?: string[] }[] = data.failed || []

      // GameBoost told us value types ("must be an integer"): remember them for this game
      if (data.learnedTypes && Object.keys(data.learnedTypes).length) {
        let t: Record<string, string> = {}
        try { t = JSON.parse(getValues("gameboost.fieldTypes") || "{}") || {} } catch { /* {} */ }
        setValue("gameboost.fieldTypes", JSON.stringify({ ...t, ...data.learnedTypes }))
      }

      // GameBoost said which listing details it needs (e.g. platform, account_level):
      // add those fields to the shared "Listing details" so they can be filled in once.
      const missing = Array.from(new Set(failedList.flatMap(f => f.missingFields || [])))
      let missingNote = ""
      if (missing.length) {
        let current: Record<string, unknown> = {}
        try { current = JSON.parse(getValues("gameboost.accountData") || "{}") || {} } catch { /* keep {} */ }
        const added = missing.filter(k => !(k in current))
        for (const k of added) current[k] = ""
        if (added.length) setValue("gameboost.accountData", JSON.stringify(current, null, 2), { shouldValidate: true })
        // GameBoost said "required": mark them required (red *) for this game from now on
        const req = new Set((getValues("gameboost.requiredFields") || "").split(",").map(x => x.trim()).filter(Boolean))
        missing.forEach(k => req.add(k))
        setValue("gameboost.requiredFields", [...req].join(","), { shouldValidate: true })
        const nice = missing.map(k => k.replace(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase())).join(", ")
        missingNote = `GameBoost needs these listing details for ${values.gameboost.gameName || "this game"}: ${nice}. ` +
          `They are now marked required (red *) in each offer's "Listing details" - fill them in and submit again.`
      }
      const otherBad = Array.from(new Set(failedList.flatMap(f => f.badFields || []))).filter(k => !missing.includes(k))
      if (otherBad.length) {
        const nice = otherBad.map(k => k.replace(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase())).join(", ")
        missingNote += (missingNote ? "\n" : "") + `Check these listing details: ${nice} (see the GameBoost message on the offer).`
      }
      const publishedList: { title: string; id: number; status: string; warning?: string }[] = data.published || []
      const where = values.gameboost.enabled ? " to GameBoost + sheet" : " to the sheet"

      const parts = [`✅ ${added} submitted${where}`]
      if (values.gameboost.enabled && publishedList.length) {
        const drafts = publishedList.filter(p => p.status !== "listed").length
        if (drafts) parts.push(`${drafts} not live yet (draft/pending)`)
      }
      if (skipped) parts.push(`${skipped} skipped (already existed)`)
      if (failedList.length) parts.push(`${failedList.length} failed on GameBoost - fix and resubmit`)

      const warnings = publishedList.filter(p => p.warning).map(p => `#${p.id}: ${p.warning}`)
      if (missingNote) warnings.unshift(missingNote)

      if (added === 0) {
        setSubmitWarning(
          skipped && !failedList.length
            ? `⚠️ 0 submitted - all ${skipped} title(s) already exist on the sheet.`
            : [`⚠️ ${parts.slice(1).join(", ") || "0 submitted"}`, ...warnings].join("\n")
        )
      } else if (failedList.length || warnings.length) {
        setSubmitWarning([parts.join(", "), ...warnings].join("\n"))
      } else {
        setSubmitSuccess(parts.join(", "))
      }

      // Re-read the true count from the sheet instead of guessing locally -
      // this is what was making the counter drift.
      await fetchDailyCount(values.employee)

      // Keep duplicates AND GameBoost failures in the form so they can be fixed
      const serverDuplicates: string[] = data.duplicates || []
      const failedByTitle = new Map(failedList.map(f => [f.title, f.error]))

      const remainingInForm = values.offers.filter(offer => {
        const t = normalize(offer.title)
        return serverDuplicates.includes(t) || failedByTitle.has(t)
      })

      reset({
        employee: values.employee,
        // current values: keeps fields/types the app just learned from GameBoost's reply
        gameboost: getValues("gameboost"),
        offers: remainingInForm.length > 0 ? remainingInForm : [emptyOffer(bulkPrice.trim())],
      })

      const newDuplicateMap: Record<number, boolean> = {}
      const newErrors: Record<number, string> = {}
      remainingInForm.forEach((offer, i) => {
        const t = normalize(offer.title)
        if (serverDuplicates.includes(t)) newDuplicateMap[i] = true
        if (failedByTitle.has(t)) newErrors[i] = failedByTitle.get(t)!
      })
      setDuplicateTitles(newDuplicateMap)
      setGbErrors(newErrors)

    } catch {
      setSubmitError("❌ Connection error. Please try again.")
    } finally {
      setIsSubmitting(false)
    }
  }

  const employees = useMemo(() => ["M", "Ms", "V", "G", "GS", "S", "R", "I1", "I2"], [])

  return (
    <section className="flex w-full max-w-300 px-[10%] py-20 rounded-2xl items-center justify-center ">
      <Card className="bg-neutral-700/70 border-0 w-full">
        <CardHeader className="border-b-neutral-400 border-b">
          <NavBar active="list" />
          <CardTitle className="text-white">Less Sting Form App</CardTitle>
          <CardDescription>A better more efficient way to list offers</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-6 w-full">

              <FormField
                control={control}
                name="employee"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-neutral-300">Employee</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="text-neutral-700 bg-neutral-300">
                          <SelectValue placeholder="Select employee" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="bg-neutral-200">
                        {employees.map(e => (
                          <SelectItem key={e} value={e}>{e}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {!selectedEmployee ? (
                <p className="text-sm text-muted-foreground">Please select an employee to continue</p>
              ) : (
                <>
                  <p className="text-l text-white font-medium">
                    {loadingCount ? "Checking today's submissions..." : `Offers submitted today: ${dailyCount}`}
                  </p>
                  {countError && (
                    <p className="text-red-300 bg-red-950/40 p-2 rounded text-sm whitespace-pre-wrap">{countError}</p>
                  )}

                  <GameBoostPanel form={form} onTemplate={onTemplate} />

                  {/* Bulk controls */}
                  <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-end border border-neutral-600 bg-neutral-800/60 p-3 rounded-lg">
                    <div className="flex-1">
                      <label className="text-sm text-neutral-300 block mb-1">Price for all offers</label>
                      <Input
                        className="border-neutral-600 bg-neutral-200 text-neutral-900"
                        placeholder="e.g. 100 or x2"
                        value={bulkPrice}
                        onChange={(e) => setBulkPrice(e.target.value)}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={applyPriceToAll}
                      disabled={!bulkPrice.trim()}
                    >
                      Apply price to all
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={addTenOffers}
                    >
                      ➕ Add 10 offers
                    </Button>
                  </div>

                  {fields.map((field, index) => {
                    const price = watchedOffers[index]?.price || ""
                    const multiplier = isMultiplier(price)
                    const resolved = gbEnabled ? resolvePrice(price, watchedOffers[index]?.sourcePrice) : null
                    return (
                    <div key={field.id} className={`border text-white bg-neutral-900 p-4 rounded-lg space-y-3 relative ${gbErrors[index] ? "border-red-500" : "border-neutral-500"}`}>

                      {duplicateTitles[index] && (
                        <div className="absolute top-2 right-4 text-xs font-bold text-red-400 animate-pulse">
                          ⚠️ DUPLICATE
                        </div>
                      )}

                      {gbErrors[index] && (
                        <p className="text-xs text-red-300 bg-red-950/40 p-2 rounded whitespace-pre-wrap">
                          GameBoost rejected this offer: {gbErrors[index]}
                        </p>
                      )}

                      <FormField
                        control={control}
                        name={`offers.${index}.link`}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Link</FormLabel>
                            <FormControl>
                              <Input className="border-neutral-600" {...field} placeholder="https://..." />
                            </FormControl>
                            {gbEnabled && (() => {
                              const info = linkInfo[(field.value || "").trim()]
                              if (!info) return null
                              const cls = "text-xs"
                              if (info.state === "loading") return <p className={`${cls} text-neutral-400`}>🔎 Getting images from the link...</p>
                              if (info.state === "ok" || info.state === "none") return (
                                <div className="space-y-0.5">
                                  <p className={`${cls} text-green-400`}>✓ Link is live</p>
                                  {info.state === "ok" && info.count
                                    ? <p className={`${cls} text-sky-400`}>🖼 {info.count} image(s) added from the link</p>
                                    : info.state === "none" && <p className={`${cls} text-yellow-300`}>⚠ No images on this page - paste an image link below</p>}
                                  {info.price
                                    ? <p className={`${cls} text-violet-300`}>💶 Price on the page: {info.priceText || info.price} (used for multipliers)</p>
                                    : <p className={`${cls} text-neutral-400`}>
                                        No price found on the page - type it in Source price if you use a multiplier{" "}
                                        <a className="underline" target="_blank" rel="noreferrer"
                                          href={`/api/source/preview?debug=1&url=${encodeURIComponent((field.value || "").trim())}`}>(see why)</a>
                                      </p>}
                                </div>
                              )
                              if (info.state === "not_found") return <p className={`${cls} text-red-400 font-semibold`}>⛔ This offer no longer exists (offer not found)</p>
                              return <p className={`${cls} text-yellow-300`}>⚠ Couldn&apos;t open the link{info.message ? ` (${info.message})` : ""} - add images by hand</p>
                            })()}
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={control}
                        name={`offers.${index}.title`}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className={duplicateTitles[index] ? "text-red-400" : ""}>Title</FormLabel>
                            <FormControl>
                              <Input
                                className={`border-neutral-600 ${duplicateTitles[index] ? "border-red-500 bg-red-950/20 focus-visible:ring-red-500" : ""}`}
                                {...field}
                                onBlur={() => {
                                  field.onBlur()
                                  const fixed = cleanTitle(field.value || "")
                                  if (fixed !== field.value) field.onChange(fixed)
                                }}
                                placeholder="Offer title"
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={control}
                        name={`offers.${index}.price`}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Price {gbEnabled && <span className="text-neutral-400 font-normal">(a price, or any multiplier: x2, x1.75, 2x...)</span>}</FormLabel>
                            <div className="flex gap-2">
                              <FormControl>
                                <Input className="border-neutral-600" {...field} placeholder="0" />
                              </FormControl>
                              <Select onValueChange={(val) => field.onChange(val)}>
                                <SelectTrigger className="border-neutral-600 w-24">
                                  <SelectValue placeholder="x?" />
                                </SelectTrigger>
                                <SelectContent>
                                  {["x2.2", "x2", "x1.9", "x1.8"].map(v => (
                                    <SelectItem key={v} value={v}>{v}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {gbEnabled && multiplier && (
                        <FormField
                          control={control}
                          name={`offers.${index}.sourcePrice`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Source price (from the link) - multiplied by {price.trim()}</FormLabel>
                              <FormControl>
                                <Input className="border-neutral-600" inputMode="decimal" {...field} placeholder="price of the account at the link" />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      )}
                      {gbEnabled && resolved?.value !== undefined && (
                        <p className="text-xs text-sky-300">GameBoost price: {resolved.value.toFixed(2)}{multiplier ? ` (= ${watchedOffers[index]?.sourcePrice} × ${price.trim().replace(/[x×*]/gi, "")})` : ""}</p>
                      )}

                      {gbEnabled && (
                        <FormField
                          control={control}
                          name={`offers.${index}.imageUrls`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Image URLs (filled automatically from the link - one per line, first image must show the account)</FormLabel>
                              <FormControl>
                                <Textarea className="border-neutral-600 min-h-[40px] font-mono text-xs" {...field} placeholder="https://..." />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      )}

                      {gbEnabled && gameSlug && (
                        <FormField
                          control={control}
                          name={`offers.${index}.accountData`}
                          render={({ field: f }) => (
                            <FormItem className="border border-neutral-700 rounded-md p-2">
                              <FormLabel>Listing details for this account</FormLabel>
                              <AccountDataFields
                                value={f.value || ""}
                                onChange={v => f.onChange(v)}
                                inherited={defaultsObj}
                                template={gbTemplate}
                                hints={gbHints}
                                required={requiredList}
                                types={typesObj}
                                idPrefix={`o${field.id}`}
                              />
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      )}

                      <FormField
                          control={control}
                          name={`offers.${index}.note`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Note (optional)</FormLabel>
                              <FormControl>
                                <Textarea className="border-neutral-600 min-h-[40px]" {...field} placeholder="Any notes..." />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                      {gbEnabled && (
                        <details className="space-y-3" open={!!form.formState.errors.offers?.[index]?.description}>
                          <summary className="cursor-pointer text-sm text-neutral-300">More GameBoost fields (description, credentials)</summary>
                          <FormField
                            control={control}
                            name={`offers.${index}.description`}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Description (leave empty to use the default)</FormLabel>
                                <FormControl>
                                  <Textarea className="border-neutral-600 min-h-[60px]" {...field} />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={control}
                            name={`offers.${index}.credentials`}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Credentials (optional for manual delivery - stored encrypted by GameBoost)</FormLabel>
                                <FormControl>
                                  <Textarea className="border-neutral-600 min-h-[40px]" {...field} placeholder="Leave empty: you deliver by hand in the order chat" />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </details>
                      )}

                      {fields.length > 1 && (
                        <Button className="w-full mt-2" type="button" variant="destructive" size="sm" onClick={() => remove(index)}>
                          Remove this offer
                        </Button>
                      )}
                    </div>
                    )
                  })}

                  <Button
                    className="w-full border-dashed border-2 border-neutral-500 bg-transparent hover:bg-neutral-800"
                    type="button"
                    onClick={() => append(emptyOffer(bulkPrice.trim()))}
                  >
                    ➕ Add another offer
                  </Button>

                  <div className="pt-4 border-t border-neutral-600">
                    {submitError && <p className="text-red-400 bg-red-950/30 p-2 rounded mb-3 text-center text-sm font-medium whitespace-pre-wrap">{submitError}</p>}
                    {submitWarning && <p className="text-yellow-400 bg-yellow-950/30 p-2 rounded mb-3 text-center text-sm font-medium whitespace-pre-wrap">{submitWarning}</p>}
                    {submitSuccess && <p className="text-green-400 bg-green-950/30 p-2 rounded mb-3 text-center text-sm font-medium">{submitSuccess}</p>}
                    {Object.keys(form.formState.errors).length > 0 && form.formState.isSubmitted && (
                      <p className="text-red-300 text-xs text-center mb-2">Some fields need fixing - check the red messages above.</p>
                    )}

                    <Button
                      type="submit"
                      disabled={!selectedEmployee || isSubmitting}
                      className="bg-white w-full text-black hover:bg-neutral-200 font-bold py-6 text-lg"
                    >
                      {isSubmitting
                        ? (gbEnabled ? "Creating on GameBoost..." : "Processing...")
                        : (gbEnabled ? "Submit & Publish to GameBoost" : "Submit All Offers")}
                    </Button>
                  </div>
                </>
              )}
            </form>
          </Form>
        </CardContent>
      </Card>
    </section>
  )
}

export default ListingForm
