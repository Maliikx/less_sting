"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { UseFormReturn } from "react-hook-form"
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { FormValues } from "./schema"
import AccountDataFields, { templateDefaults } from "./accountDataFields"

// Last account data used per game, so switching games fills everything in automatically
const PER_GAME_KEY = "ls_gb_accountdata_by_game_v1"
function readPerGame(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(PER_GAME_KEY) || "{}") || {} } catch { return {} }
}
function savePerGame(slug: string, json: string) {
  try { localStorage.setItem(PER_GAME_KEY, JSON.stringify({ ...readPerGame(), [slug]: json })) } catch { /* ignore */ }
}
// Required listing-detail fields per game (from the template or learned from GameBoost errors)
const REQ_KEY = "ls_gb_required_by_game_v1"
function readRequired(): Record<string, string[]> {
  try { return JSON.parse(localStorage.getItem(REQ_KEY) || "{}") || {} } catch { return {} }
}
export function saveRequired(slug: string, keys: string[]) {
  try { localStorage.setItem(REQ_KEY, JSON.stringify({ ...readRequired(), [slug]: keys })) } catch { /* ignore */ }
}
// Learned value types per game ("apex_coins_count": "integer"), from GameBoost's errors
const TYPES_KEY = "ls_gb_field_types_by_game_v1"
function readTypes(): Record<string, Record<string, string>> {
  try { return JSON.parse(localStorage.getItem(TYPES_KEY) || "{}") || {} } catch { return {} }
}
function saveTypes(slug: string, json: string) {
  try { localStorage.setItem(TYPES_KEY, JSON.stringify({ ...readTypes(), [slug]: JSON.parse(json || "{}") })) } catch { /* ignore */ }
}

// Fields the user marked optional by hand (detection never overrides that)
const OPT_KEY = "ls_gb_user_optional_by_game_v1"
function readUserOptional(): Record<string, string[]> {
  try { return JSON.parse(localStorage.getItem(OPT_KEY) || "{}") || {} } catch { return {} }
}
function saveUserOptional(slug: string, keys: string[]) {
  try { localStorage.setItem(OPT_KEY, JSON.stringify({ ...readUserOptional(), [slug]: keys })) } catch { /* ignore */ }
}
// Games already checked with GameBoost (so detection runs once per game, not every time)
const PROBED_KEY = "ls_gb_probed_games_v1"
function wasProbed(slug: string) {
  try { return !!(JSON.parse(localStorage.getItem(PROBED_KEY) || "{}") || {})[slug] } catch { return false }
}
function markProbed(slug: string) {
  try { localStorage.setItem(PROBED_KEY, JSON.stringify({ ...(JSON.parse(localStorage.getItem(PROBED_KEY) || "{}") || {}), [slug]: Date.now() })) } catch { /* ignore */ }
}
const splitList = (s: string | undefined) => (s || "").split(",").map(x => x.trim()).filter(Boolean)

const parseObj = (t: string | undefined) => {
  try { const v = JSON.parse(t || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null } catch { return null }
}

type Game = { id: number; name: string; slug: string }

/** Batch-level GameBoost settings: applied to every offer in the form. */
export default function GameBoostPanel({
  form,
  onTemplate,
}: {
  form: UseFormReturn<FormValues>
  /** Shares the game's template + GameBoost hints with the offer cards */
  onTemplate?: (template: Record<string, unknown> | null, hints: Record<string, string>) => void
}) {
  const { control, watch, setValue } = form
  const enabled = watch("gameboost.enabled")
  const gameName = watch("gameboost.gameName")
  const gameSlug = watch("gameboost.gameSlug")

  const [search, setSearch] = useState("")
  const [games, setGames] = useState<Game[]>([])
  const [gameMsg, setGameMsg] = useState<string | null>(null)
  const [templateRaw, setTemplateRaw] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const searchGames = async () => {
    setBusy(true)
    setGameMsg(null)
    try {
      const res = await fetch(`/api/gameboost/games?search=${encodeURIComponent(search.trim())}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Could not load games")
      setGames(data.games || [])
      if (!data.games?.length) setGameMsg("No games found")
    } catch (e) {
      setGameMsg(e instanceof Error ? e.message : "Could not load games")
    } finally {
      setBusy(false)
    }
  }

  const [template, setTemplate] = useState<Record<string, unknown> | null>(null)
  const accountData = watch("gameboost.accountData") || ""
  const requiredFields = watch("gameboost.requiredFields") || ""
  const fieldTypes = watch("gameboost.fieldTypes") || ""
  const typesObj = (() => { try { return JSON.parse(fieldTypes || "{}") || {} } catch { return {} } })()

  /**
   * Load the game's template. mode:
   *  "pick"   - game just chosen: use the values last used for this game, else the template's
   *  "reset"  - "Reset to template" button: template values only
   *  "silent" - page opened with a saved game: only load field options, keep current values
   */
  // Which game the listing details currently on screen belong to (null while switching games)
  const dataFor = useRef<string | null>(null)

  const loadTemplate = useCallback(async (slug: string, mode: "pick" | "reset" | "silent") => {
    if (!slug) return
    setBusy(true)
    try {
      const res = await fetch(`/api/gameboost/template?game=${encodeURIComponent(slug)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Could not load template")
      setTemplateRaw(JSON.stringify(data.raw, null, 2))
      const tpl = (data.accountData || {}) as Record<string, unknown>
      setTemplate(tpl)
      // required = what the template says + what GameBoost told us before for this game
      const userOpt = readUserOptional()[slug] || []
      const req = Array.from(new Set([...(data.required || []), ...(readRequired()[slug] || [])])).filter(k => !userOpt.includes(k))
      setValue("gameboost.requiredFields", req.join(","), { shouldValidate: true })
      saveRequired(slug, req)
      setValue("gameboost.fieldTypes", JSON.stringify(readTypes()[slug] || {}))
      if (mode === "silent") { dataFor.current = slug; return }
      const remembered = mode === "pick" ? parseObj(readPerGame()[slug]) : null
      // Template keys first (so new required fields appear), remembered values on top
      const next = { ...templateDefaults(tpl), ...(remembered || {}) }
      setValue("gameboost.accountData", JSON.stringify(next, null, 2), { shouldValidate: true })
      dataFor.current = slug
      setGameMsg(remembered ? "Filled with the values you used last time for this game" : "Template loaded - fill in the fields once, they are remembered for this game")
    } catch (e) {
      setGameMsg(e instanceof Error ? e.message : "Could not load template")
    } finally {
      setBusy(false)
    }
  }, [setValue])

  // Page opened with a game already selected (saved settings): load its field options once
  const loadedFor = useRef<string | null>(null)
  useEffect(() => {
    if (enabled && gameSlug && loadedFor.current !== gameSlug) {
      loadedFor.current = gameSlug
      loadTemplate(gameSlug, "silent")
    }
  }, [enabled, gameSlug, loadTemplate])

  // Remember what's typed for the current game
  useEffect(() => {
    // Only save when the values on screen really belong to this game (not mid-switch)
    if (gameSlug && dataFor.current === gameSlug && parseObj(accountData)) savePerGame(gameSlug, accountData)
  }, [gameSlug, accountData])
  useEffect(() => {
    if (gameSlug && dataFor.current === gameSlug) saveRequired(gameSlug, splitList(requiredFields))
  }, [gameSlug, requiredFields])
  useEffect(() => {
    if (gameSlug && dataFor.current === gameSlug) saveTypes(gameSlug, fieldTypes)
  }, [gameSlug, fieldTypes])

  /* ---------------- detect required fields by asking GameBoost (nothing is created) ---------------- */
  const [detect, setDetect] = useState<{ running: boolean; msg?: string; error?: boolean }>({ running: false })
  const [hints, setHints] = useState<Record<string, string>>({})

  const detectRequired = useCallback(async (gameId: number, slug: string) => {
    setDetect({ running: true, msg: "Asking GameBoost which listing details are required..." })
    try {
      const res = await fetch("/api/gameboost/probe-required", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Detection failed")
      if (slug !== form.getValues("gameboost.gameSlug")) return // user switched games meanwhile
      const found: string[] = data.required || []
      const userOpt = readUserOptional()[slug] || []
      const req = Array.from(new Set([...splitList(form.getValues("gameboost.requiredFields")), ...found])).filter(k => !userOpt.includes(k))
      setValue("gameboost.requiredFields", req.join(","), { shouldValidate: true })
      saveRequired(slug, req)
      // make sure every field GameBoost mentioned is on screen
      const cur = parseObj(form.getValues("gameboost.accountData")) || {}
      let changed = false
      for (const k of data.fields || []) if (!(k in cur)) { cur[k] = ""; changed = true }
      if (changed) setValue("gameboost.accountData", JSON.stringify(cur, null, 2), { shouldValidate: true })
      setHints(data.messages || {})
      markProbed(slug)
      setDetect({
        running: false,
        msg: found.length
          ? `GameBoost requires ${found.length} listing detail(s) for this game - marked with a red *.`
          : "GameBoost didn't report any required listing details for this game.",
      })
    } catch (e) {
      setDetect({ running: false, error: true, msg: `Couldn't detect required fields: ${e instanceof Error ? e.message : "error"}. You can mark them by clicking the labels.` })
    }
  }, [form, setValue])

  useEffect(() => {
    onTemplate?.(template, hints)
  }, [template, hints, onTemplate])

  /** Click on a field's * / (optional) label */
  const toggleRequired = (key: string) => {
    if (!gameSlug) return
    const req = new Set(splitList(requiredFields))
    const opt = new Set(readUserOptional()[gameSlug] || [])
    if (req.has(key)) { req.delete(key); opt.add(key) } else { req.add(key); opt.delete(key) }
    saveUserOptional(gameSlug, [...opt])
    setValue("gameboost.requiredFields", [...req].join(","), { shouldValidate: true })
  }

  const pickGame = (id: string) => {
    const g = games.find(x => String(x.id) === id)
    if (!g) return
    dataFor.current = null
    setValue("gameboost.gameId", g.id, { shouldValidate: true })
    setValue("gameboost.gameSlug", g.slug)
    setValue("gameboost.gameName", g.name)
    loadedFor.current = g.slug
    setHints({})
    setDetect({ running: false })
    loadTemplate(g.slug, "pick").then(() => {
      // First time this game is used in this browser: ask GameBoost what's required
      if (!wasProbed(g.slug)) detectRequired(g.id, g.slug)
    })
  }

  return (
    <div className="border border-sky-700/60 bg-sky-950/30 p-4 rounded-lg space-y-4 text-white">
      <FormField
        control={control}
        name="gameboost.enabled"
        render={({ field }) => (
          <label className="flex items-center gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              className="size-5 accent-sky-500"
              checked={field.value}
              onChange={e => field.onChange(e.target.checked)}
            />
            <span className="font-semibold">Publish to GameBoost</span>
            <span className="text-xs text-neutral-400">
              (manual delivery offers - off = only log to the sheet like before)
            </span>
          </label>
        )}
      />

      <FormField
        control={control}
        name="gameboost.filterWords"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Word filter (removed from every title and description)</FormLabel>
            <FormControl>
              <Textarea
                className="border-neutral-600 min-h-[40px] text-sm"
                placeholder={"One per line or comma separated, e.g.\ncheap, instant, funpay"}
                {...field}
              />
            </FormControl>
            <p className="text-xs text-neutral-400">
              Whole words only, any letter case (&quot;acc&quot; won&apos;t touch &quot;account&quot;). Titles update when you leave the title box; descriptions are cleaned on submit. Saved in this browser.
            </p>
            <FormMessage />
          </FormItem>
        )}
      />

      {enabled && (
        <>
          {/* Game */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-neutral-200 block">Game</label>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                className="border-neutral-600"
                placeholder="Search game, e.g. valorant"
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    searchGames()
                  }
                }}
              />
              <Button type="button" variant="secondary" onClick={searchGames} disabled={busy}>
                Search
              </Button>
            </div>
            {games.length > 0 && (
              <Select onValueChange={pickGame}>
                <SelectTrigger className="border-neutral-600 w-full">
                  <SelectValue placeholder={`Pick from ${games.length} result(s)`} />
                </SelectTrigger>
                <SelectContent>
                  {games.map(g => (
                    <SelectItem key={g.id} value={String(g.id)}>
                      {g.name} <span className="text-neutral-500">({g.slug}, #{g.id})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <FormField
              control={control}
              name="gameboost.gameId"
              render={() => (
                <FormItem>
                  <p className="text-sm">
                    Selected:{" "}
                    {gameName ? (
                      <b className="text-sky-300">{gameName}</b>
                    ) : (
                      <span className="text-neutral-400">none</span>
                    )}
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
            {gameMsg && <p className="text-xs text-neutral-300">{gameMsg}</p>}
          </div>

          {/* Delivery time */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FormField
              control={control}
              name="gameboost.deliveryDuration"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Guaranteed delivery time</FormLabel>
                  <FormControl>
                    <Input className="border-neutral-600" inputMode="numeric" placeholder="e.g. 2" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name="gameboost.deliveryUnit"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Unit</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="border-neutral-600 w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {["minutes", "hours", "days"].map(u => (
                        <SelectItem key={u} value={u}>
                          {u}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={control}
            name="gameboost.description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Default description (used when an offer has none)</FormLabel>
                <FormControl>
                  <Textarea className="border-neutral-600 min-h-[80px]" placeholder="Account details, what the buyer gets..." {...field} />
                </FormControl>
                <p className="text-xs text-neutral-400">
                  Max 2048 chars. Avoid: refund, money-back, replacement, lifetime, no warranty.
                </p>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={control}
            name="gameboost.accountData"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-center justify-between gap-2">
                  <FormLabel>Default listing details for {gameName || "this game"} (used by every offer unless the offer changes them)</FormLabel>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={!gameSlug || detect.running}
                      onClick={() => {
                        const id = form.getValues("gameboost.gameId")
                        if (id && gameSlug) detectRequired(id, gameSlug)
                      }}
                      title="Asks GameBoost which fields it requires (nothing is created)"
                    >
                      {detect.running ? "Detecting..." : "Detect required fields"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={!gameSlug || busy}
                      onClick={() => loadTemplate(gameSlug || "", "reset")}
                    >
                      Reset to template
                    </Button>
                  </div>
                </div>
                {detect.msg && (
                  <p className={`text-xs ${detect.error ? "text-yellow-300" : detect.running ? "text-neutral-400" : "text-sky-300"}`}>{detect.msg}</p>
                )}
                {gameSlug ? (
                  <AccountDataFields
                    value={field.value || ""}
                    template={template}
                    required={splitList(requiredFields)}
                    hints={hints}
                    types={typesObj}
                    onToggleRequired={toggleRequired}
                    onChange={v => field.onChange(v)}
                  />
                ) : (
                  <p className="text-xs text-neutral-400">Pick a game first - its fields appear here automatically.</p>
                )}
                <p className="text-xs text-neutral-400">
                  Shared by all offers below and remembered per game. Click <b>*</b> / <b>(optional)</b> next to a field to switch it. Empty optional fields are not sent.
                </p>
                <FormMessage />
              </FormItem>
            )}
          />
          {templateRaw && (
            <details className="text-xs">
              <summary className="cursor-pointer text-neutral-300">Show full GameBoost template (reference)</summary>
              <pre className="mt-2 max-h-64 overflow-auto bg-black/40 p-2 rounded">{templateRaw}</pre>
            </details>
          )}

          <details className="space-y-3">
            <summary className="cursor-pointer text-sm text-neutral-300">Optional: delivery instructions, keywords</summary>
            <FormField
              control={control}
              name="gameboost.deliveryInstructions"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Delivery instructions (shown to buyer after purchase - NOT encrypted, never put passwords here)</FormLabel>
                  <FormControl>
                    <Textarea className="border-neutral-600" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name="gameboost.dump"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Search keywords (dump)</FormLabel>
                  <FormControl>
                    <Input className="border-neutral-600" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </details>

          <FormField
            control={control}
            name="gameboost.listNow"
            render={({ field }) => (
              <label className="flex items-center gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="size-4 accent-sky-500"
                  checked={field.value}
                  onChange={e => field.onChange(e.target.checked)}
                />
                <span className="text-sm">List immediately (untick to create as hidden draft for checking first)</span>
              </label>
            )}
          />
        </>
      )}
    </div>
  )
}
