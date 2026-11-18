"use client"

import { Fragment, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import NavBar from "../navBar"
import { parseBatch, type BatchLine } from "@/lib/auto/lines"
import { canPublish, revalidate, toPublishItem, type ReviewRow } from "@/lib/auto/review"
import type { PublishResult } from "@/lib/destinations/types"
import type { GameRef } from "@/lib/auto/games"

const CHUNK = 6 // /api/ai/prepare max
const PUBLISH_CHUNK = 20 // /api/auto/publish max
const GAP_MS = 1500 // between prepare calls (the server spaces pages inside a call)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Row = ReviewRow & { key: string; result?: PublishResult }
type Settings = { deliveryDuration: string; deliveryUnit: "minutes" | "hours" | "days"; defaultDescription: string }
const DEFAULT_SETTINGS: Settings = { deliveryDuration: "1", deliveryUnit: "hours", defaultDescription: "" }

const STATUS: Record<string, { label: string; cls: string }> = {
  ready: { label: "ready", cls: "bg-green-700" },
  needs_review: { label: "check", cls: "bg-yellow-700" },
  duplicate: { label: "duplicate", cls: "bg-neutral-600" },
  dead: { label: "dead", cls: "bg-neutral-700" },
  blocked: { label: "blocked", cls: "bg-red-800" },
  error: { label: "error", cls: "bg-red-700" },
  created: { label: "draft created", cls: "bg-blue-700" },
  failed: { label: "publish failed", cls: "bg-red-700" },
}

function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("ls-auto-settings") || "{}") }
  } catch {
    return DEFAULT_SETTINGS
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data as T
}

export default function AutoClient() {
  const [text, setText] = useState("")
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [showSettings, setShowSettings] = useState(false)
  const [rows, setRows] = useState<Row[]>([])
  const [skipped, setSkipped] = useState<{ repeated: BatchLine[]; invalid: BatchLine[] }>({ repeated: [], invalid: [] })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | { what: string; done: number; total: number }>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => setSettings(loadSettings()), [])
  const saveSettings = (s: Settings) => {
    setSettings(s)
    try {
      localStorage.setItem("ls-auto-settings", JSON.stringify(s))
    } catch {
      /* private mode: fine */
    }
  }

  const parsed = useMemo(() => parseBatch(text), [text])

  /** Prepare lines in chunks; `picks` = categoryId -> game chosen by the user. Replaces rows with the same key. */
  async function prepare(lines: { link: string; price: string; seller: string; key: string }[], picks: Record<string, GameRef> = {}) {
    setError(null)
    setBusy({ what: "Reading offers", done: 0, total: lines.length })
    try {
      for (let i = 0; i < lines.length; i += CHUNK) {
        if (i > 0) await sleep(GAP_MS)
        const chunk = lines.slice(i, i + CHUNK)
        const data = await postJson<{ results: ReviewRow[] }>("/api/ai/prepare", {
          items: chunk.map(({ link, price, seller }) => ({ link, price, seller })),
          picks,
          defaultDescription: settings.defaultDescription || undefined,
        })
        const fresh: Row[] = data.results.map((r, j) => ({ ...r, key: chunk[j].key }))
        setRows(prev => {
          const map = new Map(prev.map(r => [r.key, r]))
          for (const r of fresh) map.set(r.key, r)
          return [...map.values()]
        })
        setSelected(prev => {
          const next = new Set(prev)
          for (const r of fresh) { if (canPublish(r)) next.add(r.key); else next.delete(r.key) }
          return next
        })
        setBusy({ what: "Reading offers", done: Math.min(lines.length, i + chunk.length), total: lines.length })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const start = () => {
    setRows([])
    setSelected(new Set())
    setOpen(null)
    setNotice(null)
    setSkipped({ repeated: parsed.repeated, invalid: parsed.invalid })
    void prepare(parsed.lines.map(l => ({ link: l.link, price: l.price, seller: l.seller, key: l.lotId! })))
  }

  const edit = (key: string, patch: Partial<Row>) =>
    setRows(prev =>
      prev.map(r => {
        if (r.key !== key) return r
        const next = { ...(revalidate({ ...r, ...patch }) as Row), key, result: r.result }
        setSelected(s => {
          const n = new Set(s)
          if (!canPublish(next)) n.delete(key)
          return n
        })
        return next
      })
    )

  /* ---- unknown games: one picker per FunPay category ---- */
  const unknown = useMemo(() => {
    const m = new Map<string, { category: string; keys: string[] }>()
    for (const r of rows) {
      if (r.result || r.game || !r.categoryId || !r.flags.some(f => f.code === "game_unknown")) continue
      const g = m.get(r.categoryId) || { category: r.category || r.categoryId, keys: [] }
      g.keys.push(r.key)
      m.set(r.categoryId, g)
    }
    return [...m.entries()]
  }, [rows])

  const applyGame = (categoryId: string, game: GameRef) => {
    const keys = unknown.find(([id]) => id === categoryId)?.[1].keys || []
    const lines = rows.filter(r => keys.includes(r.key)).map(r => ({ link: r.link, price: r.priceInput, seller: r.seller, key: r.key }))
    void prepare(lines, { [categoryId]: game })
  }

  /* ---- publish ---- */
  const publishable = rows.filter(r => selected.has(r.key) && canPublish(r) && !r.result)
  async function publish() {
    if (!publishable.length) return
    if (!window.confirm(`Create ${publishable.length} offer(s) on GameBoost as DRAFTS and log them to the sheet?`)) return
    setError(null)
    setNotice(null)
    setBusy({ what: "Publishing", done: 0, total: publishable.length })
    let created = 0
    try {
      for (let i = 0; i < publishable.length; i += PUBLISH_CHUNK) {
        const chunk = publishable.slice(i, i + PUBLISH_CHUNK)
        const data = await postJson<{ results: PublishResult[]; listNow: boolean }>("/api/auto/publish", {
          items: chunk.map(toPublishItem),
          settings: { deliveryDuration: Number(settings.deliveryDuration), deliveryUnit: settings.deliveryUnit, defaultDescription: settings.defaultDescription || undefined },
        })
        const byRef = new Map(data.results.map(r => [r.ref, r]))
        created += data.results.filter(r => r.status === "created").length
        setRows(prev => prev.map(r => (byRef.has(r.canonicalId) ? { ...r, result: byRef.get(r.canonicalId) } : r)))
        setSelected(prev => {
          const n = new Set(prev)
          for (const r of chunk) n.delete(r.key)
          return n
        })
        setBusy({ what: "Publishing", done: Math.min(publishable.length, i + chunk.length), total: publishable.length })
      }
      setNotice(`${created} offer(s) created on GameBoost as drafts.`)
    } catch (e) {
      setError(`${e instanceof Error ? e.message : String(e)}. Check /manage before publishing again.`)
    } finally {
      setBusy(null)
    }
  }

  const counts = rows.reduce<Record<string, number>>((m, r) => {
    const k = r.result ? (r.result.status === "created" ? "created" : r.result.status === "duplicate" ? "duplicate" : "failed") : r.status
    m[k] = (m[k] || 0) + 1
    return m
  }, {})
  const readyKeys = rows.filter(r => canPublish(r) && !r.result).map(r => r.key)

  return (
    <div className="w-full max-w-[1300px] p-4 text-white">
      <NavBar active="auto" />

      <div className="rounded-lg border border-neutral-700 bg-[#2b2b2b] p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Batch listing</h1>
            <p className="text-xs text-neutral-400">
              One offer per line: <code>link price seller</code>. Price is a number or a multiplier (x2). Offers are created as{" "}
              <b>drafts</b> (testing).
            </p>
          </div>
          <button type="button" className="text-xs text-neutral-300 underline" onClick={() => setShowSettings(v => !v)}>
            {showSettings ? "Hide settings" : `Settings · delivery ${settings.deliveryDuration} ${settings.deliveryUnit}`}
          </button>
        </div>

        {showSettings && (
          <div className="grid gap-2 rounded bg-[#1e1e1e] p-3 text-sm sm:grid-cols-[auto_1fr]">
            <label className="flex items-center gap-2">
              Delivery time
              <input
                className="w-14 rounded bg-[#2b2b2b] px-2 py-1"
                value={settings.deliveryDuration}
                onChange={e => saveSettings({ ...settings, deliveryDuration: e.target.value.replace(/\D/g, "") })}
              />
              <select
                className="rounded bg-[#2b2b2b] px-2 py-1"
                value={settings.deliveryUnit}
                onChange={e => saveSettings({ ...settings, deliveryUnit: e.target.value as Settings["deliveryUnit"] })}
              >
                <option>minutes</option>
                <option>hours</option>
                <option>days</option>
              </select>
            </label>
            <input
              className="rounded bg-[#2b2b2b] px-2 py-1"
              placeholder="Default description (used when an offer has none)"
              value={settings.defaultDescription}
              onChange={e => saveSettings({ ...settings, defaultDescription: e.target.value })}
            />
          </div>
        )}

        <Textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={6}
          disabled={!!busy}
          placeholder={"https://funpay.com/en/lots/offer?id=81847225 x1.5 S01\nhttps://funpay.com/en/lots/offer?id=81843891 45 S02"}
          className="bg-[#1e1e1e] border-neutral-700 font-mono text-xs"
        />
        <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-400">
          <Button onClick={start} disabled={!!busy || !parsed.lines.length}>
            Prepare {parsed.lines.length || ""} offer{parsed.lines.length === 1 ? "" : "s"}
          </Button>
          {parsed.repeated.length > 0 && <span>{parsed.repeated.length} repeated link(s) skipped</span>}
          {parsed.invalid.length > 0 && <span className="text-yellow-300">{parsed.invalid.length} line(s) not understood</span>}
        </div>

        {busy && (
          <div>
            <div className="h-2 w-full rounded bg-neutral-700">
              <div className="h-2 rounded bg-green-600 transition-all" style={{ width: `${(100 * busy.done) / Math.max(1, busy.total)}%` }} />
            </div>
            <p className="mt-1 text-xs text-neutral-400">
              {busy.what}… {busy.done} / {busy.total}
            </p>
          </div>
        )}
        {error && <p className="rounded bg-red-900/60 p-2 text-sm">{error}</p>}
        {notice && <p className="rounded bg-blue-900/60 p-2 text-sm">{notice}</p>}
        {(skipped.invalid.length > 0 || skipped.repeated.length > 0) && (
          <details className="text-xs text-neutral-400">
            <summary>Skipped lines</summary>
            <ul className="mt-1 font-mono">
              {skipped.invalid.map(l => <li key={`i${l.line}`}>line {l.line}: {l.error} — {l.raw.slice(0, 80)}</li>)}
              {skipped.repeated.map(l => <li key={`r${l.line}`}>line {l.line}: repeated {l.lotId}</li>)}
            </ul>
          </details>
        )}
      </div>

      {unknown.length > 0 && (
        <div className="mt-3 rounded-lg border border-yellow-800 bg-yellow-950/40 p-3 text-sm space-y-2">
          <p className="font-semibold">Which GameBoost game? (asked once per FunPay category, then remembered)</p>
          {unknown.map(([id, g]) => <GamePicker key={id} category={g.category} count={g.keys.length} disabled={!!busy} onPick={game => applyGame(id, game)} />)}
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-3 rounded-lg border border-neutral-700 bg-[#2b2b2b] p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            {Object.entries(counts).map(([k, n]) => (
              <span key={k} className={`rounded px-2 py-0.5 ${STATUS[k]?.cls || "bg-neutral-700"}`}>{STATUS[k]?.label || k} {n}</span>
            ))}
            <span className="ml-auto" />
            <button type="button" className="underline" onClick={() => setSelected(new Set(readyKeys))}>Select all ready</button>
            <button type="button" className="underline" onClick={() => setSelected(new Set())}>None</button>
            <Button onClick={publish} disabled={!!busy || !publishable.length}>
              Publish selected ({publishable.length})
            </Button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-neutral-400">
                <tr>
                  {["", "Status", "Title", "Price", "Imgs", "Game", "Seller", "Notes"].map(h => (
                    <th key={h} className="border-b border-neutral-700 p-1.5 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const st = r.result ? STATUS[r.result.status === "created" ? "created" : r.result.status === "duplicate" ? "duplicate" : "failed"] : STATUS[r.status]
                  const errors = r.flags.filter(f => f.level === "error")
                  const isOpen = open === r.key
                  return (
                    <Fragment key={r.key}>
                      <tr className={`cursor-pointer border-b border-neutral-800 align-top hover:bg-neutral-800/60 ${isOpen ? "bg-neutral-800/60" : ""}`} onClick={() => setOpen(isOpen ? null : r.key)}>
                        <td className="p-1.5" onClick={e => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            disabled={!canPublish(r) || !!r.result}
                            checked={selected.has(r.key)}
                            onChange={e => setSelected(s => { const n = new Set(s); if (e.target.checked) n.add(r.key); else n.delete(r.key); return n })}
                          />
                        </td>
                        <td className="p-1.5 whitespace-nowrap"><span className={`rounded px-1.5 py-0.5 ${st?.cls}`}>{st?.label}</span></td>
                        <td className="max-w-[420px] p-1.5">
                          <div className="truncate">{r.title || r.link}</div>
                          {r.result?.offerId && <div className="text-blue-300">GameBoost #{r.result.offerId} ({r.result.offerStatus})</div>}
                          {(r.result?.error || r.result?.warning) && <div className="text-red-300">{r.result.error || r.result.warning}</div>}
                          {!r.result && errors[0] && <div className="text-yellow-300">{errors[0].message}{errors.length > 1 ? ` (+${errors.length - 1})` : ""}</div>}
                          {!r.result && !errors[0] && r.status !== "ready" && r.flags[0] && <div className="text-neutral-400">{r.flags[0].message}</div>}
                        </td>
                        <td className="p-1.5 whitespace-nowrap">
                          {r.priceEur !== undefined ? r.priceEur.toFixed(2) : "—"}
                          <div className="text-neutral-500">{r.priceInput}{r.priceText ? ` of ${r.priceText}` : ""}</div>
                        </td>
                        <td className="p-1.5">
                          {r.images.length}
                          {r.albumImages && <span className="ml-1 rounded bg-yellow-800 px-1">album</span>}
                        </td>
                        <td className="p-1.5 max-w-[140px] truncate">{r.game?.name || <span className="text-yellow-300">{r.category ? "?" : ""}</span>}</td>
                        <td className="p-1.5">{r.seller}</td>
                        <td className="p-1.5">
                          <div className="flex flex-wrap gap-1">
                            {r.defaulted.length > 0 && <span className="rounded bg-orange-600 px-1 font-semibold" title={r.defaulted.map(d => `${d.key}=${JSON.stringify(d.value)}`).join(", ")}>defaulted {r.defaulted.length}</span>}
                            {r.removed.length > 0 && <span className="rounded bg-neutral-600 px-1">removed {r.removed.length}</span>}
                            {r.aiUsed && <span className="rounded bg-purple-800 px-1">AI</span>}
                            {r.language === "translated" && <span className="rounded bg-purple-800 px-1">translated</span>}
                          </div>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-b border-neutral-800 bg-[#1e1e1e]">
                          <td colSpan={8} className="p-3">
                            <Details row={r} onEdit={patch => edit(r.key, patch)} locked={!!r.result || ["dead", "duplicate", "blocked", "error"].includes(r.status)} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function Details({ row, onEdit, locked }: { row: Row; onEdit: (p: Partial<Row>) => void; locked: boolean }) {
  const field = "w-full rounded bg-[#2b2b2b] px-2 py-1 text-xs"
  return (
    <div className="grid gap-3 text-xs lg:grid-cols-2">
      <div className="space-y-2">
        <a href={row.link} target="_blank" rel="noreferrer" className="text-neutral-400 underline">{row.link}</a>
        <label className="block">
          <span className="text-neutral-400">Title</span>
          <input className={field} value={row.title} disabled={locked} onChange={e => onEdit({ title: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-neutral-400">Description</span>
          <textarea className={field} rows={7} value={row.description} disabled={locked} onChange={e => onEdit({ description: e.target.value })} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-neutral-400">Price (number or x2)</span>
            <input className={field} value={row.priceInput} disabled={locked} onChange={e => onEdit({ priceInput: e.target.value })} />
          </label>
          <div>
            <span className="text-neutral-400">Source price</span>
            <div className="py-1">{row.priceText || "not found"}</div>
          </div>
        </div>
        <label className="block">
          <span className="text-neutral-400">Image links (one per line; imgur is not accepted)</span>
          <textarea
            className={`${field} font-mono`}
            rows={3}
            value={row.images.join("\n")}
            disabled={locked}
            onChange={e => onEdit({ images: e.target.value.split(/\s+/).map(s => s.trim()).filter(Boolean) })}
          />
        </label>
        {row.images.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {row.images.slice(0, 10).map(u => (
              // eslint-disable-next-line @next/next/no-img-element
              <a key={u} href={u} target="_blank" rel="noreferrer"><img src={u} alt="" className="h-16 w-24 rounded object-cover" /></a>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-3">
        {row.flags.length > 0 && (
          <div>
            <p className="font-semibold">Checks</p>
            <ul className="space-y-0.5">
              {row.flags.map((f, i) => (
                <li key={i} className={f.level === "error" ? "text-red-300" : f.level === "warn" ? "text-yellow-300" : "text-neutral-400"}>{f.message}</li>
              ))}
            </ul>
          </div>
        )}
        {Object.keys(row.accountData).length > 0 && (
          <div>
            <p className="font-semibold">Game fields</p>
            <ul>
              {Object.entries(row.accountData).map(([k, v]) => {
                const d = row.defaulted.find(x => x.key === k)
                return (
                  <li key={k} className={d ? "rounded bg-orange-900/70 px-1 font-semibold text-orange-200" : ""}>
                    {k}: {JSON.stringify(v)} {d && `— DEFAULTED (lowest value: ${d.reason})`}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        {row.removed.length > 0 && (
          <div>
            <p className="font-semibold">Removed</p>
            <ul className="text-neutral-400">
              {row.removed.map((x, i) => <li key={i}>“{x.text.slice(0, 120)}” — {x.reason}</li>)}
            </ul>
          </div>
        )}
        {(row.original.title || row.original.description) && (
          <details>
            <summary className="cursor-pointer text-neutral-400">Original text from the page</summary>
            <p className="mt-1 font-semibold">{row.original.title}</p>
            <p className="whitespace-pre-wrap text-neutral-400">{row.original.description}</p>
          </details>
        )}
      </div>
    </div>
  )
}

function GamePicker({ category, count, disabled, onPick }: { category: string; count: number; disabled: boolean; onPick: (g: GameRef) => void }) {
  const [q, setQ] = useState(category.replace(/\s+accounts?$/i, ""))
  const [games, setGames] = useState<GameRef[]>([])
  const [pick, setPick] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const search = async () => {
    setErr(null)
    try {
      const res = await fetch(`/api/gameboost/games?search=${encodeURIComponent(q)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setGames(data.games || [])
      setPick(data.games?.[0] ? String(data.games[0].id) : "")
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-[200px]">{category} <span className="text-neutral-400">({count})</span></span>
      <input className="rounded bg-[#1e1e1e] px-2 py-1" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === "Enter" && search()} />
      <button type="button" className="underline" onClick={search}>Search</button>
      {games.length > 0 && (
        <select className="rounded bg-[#1e1e1e] px-2 py-1" value={pick} onChange={e => setPick(e.target.value)}>
          {games.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      )}
      <Button
        disabled={disabled || !pick}
        onClick={() => {
          const g = games.find(x => String(x.id) === pick)
          if (g) onPick(g)
        }}
      >
        Use and re-check
      </Button>
      {err && <span className="text-red-300">{err}</span>}
    </div>
  )
}
