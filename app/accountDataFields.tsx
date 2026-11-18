"use client"

import { useMemo, useState } from "react"
import { guessType, type FieldType } from "@/lib/offerRules"

/**
 * Listing details (GameBoost "account_data") as plain fields.
 *
 * Two modes:
 *  - Defaults (top panel): edits the shared values for every offer.
 *  - Per offer (`inherited` set): shows the defaults greyed out and stores ONLY what this offer
 *    changes, so later changes to a default still reach offers that didn't override it.
 *
 * Number fields (counts, levels, or anything GameBoost said "must be an integer") store real
 * numbers, so GameBoost never gets "15" instead of 15.
 */
type Props = {
  value: string // JSON object as text (the form keeps it as text)
  onChange: (json: string) => void
  template: Record<string, unknown> | null
  /** Field names that must be filled */
  required?: string[]
  /** Learned value types per field */
  types?: Record<string, FieldType>
  /** GameBoost's message per field (e.g. "must be one of: PC, PlayStation") */
  hints?: Record<string, string>
  /** Click on the * / (optional) marker (defaults panel only) */
  onToggleRequired?: (key: string) => void
  /** Per-offer mode: the shared default values */
  inherited?: Record<string, unknown>
  /** Unique prefix for input ids (one per offer card) */
  idPrefix?: string
}

const humanize = (k: string) => k.replace(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase())
const isPrim = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v)
const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)

function optionsFrom(tpl: unknown): string[] | null {
  if (tpl && typeof tpl === "object" && !Array.isArray(tpl)) {
    const t = tpl as Record<string, unknown>
    for (const k of ["options", "values", "enum", "choices"]) {
      const arr = t[k]
      if (Array.isArray(arr) && arr.length) {
        return arr.map(o => (o && typeof o === "object" ? String((o as Record<string, unknown>).value ?? (o as Record<string, unknown>).label ?? JSON.stringify(o)) : String(o)))
      }
    }
  }
  return null
}

function defaultFor(tpl: unknown): unknown {
  if (tpl && typeof tpl === "object" && !Array.isArray(tpl)) {
    const t = tpl as Record<string, unknown>
    if ("default" in t) return t.default
    if (optionsFrom(t)) return ""
  }
  return tpl
}

/** Template object -> starting values (uses "default" when the template describes fields). */
export function templateDefaults(tpl: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, defaultFor(v)]))
}

function parse(value: string) {
  try {
    const v = JSON.parse(value || "{}")
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export default function AccountDataFields({
  value, onChange, template, required = [], types = {}, hints = {}, onToggleRequired, inherited, idPrefix = "ad",
}: Props) {
  const own = useMemo(() => parse(value), [value])
  const perOffer = !!inherited
  const [asJson, setAsJson] = useState(false)
  const [newKey, setNewKey] = useState("")
  // text typed into list / JSON boxes, kept until it parses
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const keys = useMemo(() => {
    const k = new Set<string>([...required, ...Object.keys(template || {}), ...Object.keys(inherited || {}), ...Object.keys(own || {})])
    return [...k].sort((a, b) => Number(required.includes(b)) - Number(required.includes(a)))
  }, [template, own, inherited, required])

  const set = (key: string, v: unknown) => {
    const next = { ...(own || {}) }
    if (perOffer && (isEmpty(v) || JSON.stringify(v) === JSON.stringify(inherited?.[key]))) delete next[key]
    else next[key] = v
    onChange(Object.keys(next).length || !perOffer ? JSON.stringify(next, null, 2) : "")
  }

  if (!perOffer && (asJson || !own)) {
    return (
      <div className="space-y-1">
        <textarea
          className="w-full rounded-md border border-neutral-600 bg-transparent p-2 font-mono text-xs min-h-[100px]"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="{}"
        />
        {!own && <p className="text-xs text-red-300">Not valid JSON - fix it to switch back to fields.</p>}
        {own && (
          <button type="button" className="text-xs underline text-neutral-300" onClick={() => setAsJson(false)}>
            Show as fields
          </button>
        )}
      </div>
    )
  }

  const doAdd = () => {
    const k = newKey.trim().toLowerCase().replace(/\s+/g, "_")
    if (k && !(k in (own || {}))) set(k, "")
    setNewKey("")
  }
  const addField = (
    <div className="flex gap-2 items-center">
      <input className="rounded-md border border-neutral-600 bg-transparent h-8 px-2 text-xs w-44" placeholder="field name, e.g. platform"
        value={newKey} onChange={e => setNewKey(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); doAdd() } }} />
      <button type="button" className="text-xs underline text-neutral-300" onClick={doAdd}>+ Add field</button>
    </div>
  )

  if (!keys.length) {
    return perOffer ? null : (
      <div className="space-y-2">
        <p className="text-xs text-neutral-400">
          No listing-detail fields found in this game&apos;s template yet. Submit once and the app adds the fields GameBoost asks for, or add one here.
        </p>
        {addField}
      </div>
    )
  }

  const box = "w-full rounded-md border border-neutral-600 bg-transparent h-9 px-2 text-sm"
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {keys.map(key => {
          const hasOwn = !!own && key in own && !isEmpty(own[key])
          const cur = hasOwn ? own![key] : perOffer ? inherited?.[key] : own?.[key]
          const fromDefault = perOffer && !hasOwn && !isEmpty(cur)
          const tpl = template?.[key]
          const options = optionsFrom(tpl)
          const type = guessType(key, types) ?? (typeof tpl === "number" ? "number" : typeof tpl === "boolean" ? "boolean" : undefined)
          const id = `${idPrefix}-${key}`
          const shown = cur === undefined || cur === null ? "" : String(cur)
          const cls = `${box} ${fromDefault ? "text-neutral-400 italic" : ""}`
          let input: React.ReactNode
          let bad = false

          if (options && isPrim(cur)) {
            const list = shown && !options.includes(shown) ? [shown, ...options] : options
            input = (
              <select id={id} className={cls} value={shown} onChange={e => set(key, e.target.value)}>
                <option value="" className="text-black">-</option>
                {list.map(o => <option key={o} value={o} className="text-black">{o}</option>)}
              </select>
            )
          } else if (type === "boolean" || typeof cur === "boolean") {
            input = (
              <select id={id} className={cls} value={cur === undefined || cur === "" ? "" : String(!!cur)}
                onChange={e => set(key, e.target.value === "" ? "" : e.target.value === "true")}>
                <option value="" className="text-black">-</option>
                <option value="true" className="text-black">Yes</option>
                <option value="false" className="text-black">No</option>
              </select>
            )
          } else if (type === "integer" || type === "number" || typeof cur === "number") {
            const text = drafts[key] ?? shown
            bad = text.trim() !== "" && !Number.isFinite(Number(text.replace(",", ".")))
            input = (
              <input id={id} className={`${cls} ${bad ? "border-red-500" : ""}`} inputMode="numeric" placeholder="0" value={text}
                onChange={e => {
                  const t = e.target.value
                  setDrafts(d => ({ ...d, [key]: t }))
                  const n = Number(t.replace(",", "."))
                  if (t.trim() === "") set(key, "")
                  else if (Number.isFinite(n)) set(key, type === "integer" ? Math.round(n) : n)
                }}
                onBlur={() => setDrafts(d => { const n = { ...d }; delete n[key]; return n })} />
            )
          } else if (type === "array" || (Array.isArray(cur) && cur.every(isPrim))) {
            input = (
              <input id={id} className={cls} placeholder="comma separated" value={drafts[key] ?? (Array.isArray(cur) ? cur.join(", ") : shown)}
                onChange={e => setDrafts(d => ({ ...d, [key]: e.target.value }))}
                onBlur={e => { set(key, e.target.value.split(",").map(s => s.trim()).filter(Boolean)); setDrafts(d => { const n = { ...d }; delete n[key]; return n }) }} />
            )
          } else if (cur !== null && typeof cur === "object") {
            input = (
              <input id={id} className={`${cls} font-mono text-xs`} value={drafts[key] ?? JSON.stringify(cur)}
                onChange={e => setDrafts(d => ({ ...d, [key]: e.target.value }))}
                onBlur={e => { try { set(key, JSON.parse(e.target.value)) } catch { /* keep draft */ } }} />
            )
          } else {
            input = <input id={id} className={cls} value={shown} onChange={e => set(key, e.target.value)} />
          }

          const empty = isEmpty(cur)
          const isReq = required.includes(key)
          return (
            <div key={key}>
              <label htmlFor={id} className={`text-xs block mb-1 ${isReq && empty ? "text-red-300" : "text-neutral-300"}`}>
                {humanize(key)}
                {onToggleRequired ? (
                  <button
                    type="button"
                    onClick={() => onToggleRequired(key)}
                    title={isReq ? "Required - click to make optional" : "Optional - click to make required"}
                    className={`ml-1 rounded px-1 hover:bg-neutral-700 ${isReq ? "text-red-400 font-bold" : "text-neutral-500"}`}
                  >
                    {isReq ? "*" : "(optional)"}
                  </button>
                ) : (
                  isReq ? <span className="ml-1 text-red-400 font-bold">*</span> : <span className="ml-1 text-neutral-500">(optional)</span>
                )}
                {(type === "integer" || type === "number") && <span className="ml-1 text-neutral-500">#</span>}
                {fromDefault && <span className="ml-1 text-neutral-500">default</span>}
              </label>
              {input}
              {bad && <p className="text-[11px] text-red-300 mt-0.5">Must be a number</p>}
              {hints[key] && <p className="text-[11px] text-neutral-400 mt-0.5">{hints[key]}</p>}
            </div>
          )
        })}
      </div>
      {!perOffer && (
        <div className="flex flex-wrap items-center gap-4">
          {addField}
          <button type="button" className="text-xs underline text-neutral-400" onClick={() => setAsJson(true)}>
            Edit as JSON
          </button>
        </div>
      )}
    </div>
  )
}
