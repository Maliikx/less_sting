"use client"

/**
 * Floating progress card (bottom-right, stays visible while scrolling), used by every long-running action:
 * batch prepare/publish (/auto), the source probe (/probe), the link check and bulk actions (/manage).
 * Several can show at once: they stack.
 */
export type ProgressToastProps = {
  label: string
  done: number
  total: number
  /** Extra line under the bar, e.g. "3 not found". */
  detail?: string
  /** Shows a Stop button. */
  onStop?: () => void
  stopLabel?: string
  /** Bar colour (tailwind bg-* class). */
  color?: string
}

export function ProgressToastStack({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-stretch gap-2 sm:left-auto sm:right-6 sm:bottom-6 sm:w-80" aria-live="polite">
      {children}
    </div>
  )
}

export default function ProgressToast({ label, done, total, detail, onStop, stopLabel = "Stop", color = "bg-green-500" }: ProgressToastProps) {
  const pct = total > 0 ? Math.min(100, Math.round((100 * done) / total)) : 0
  return (
    <div role="status" className="pointer-events-auto rounded-lg border border-neutral-600 bg-neutral-900/95 p-3 text-white shadow-2xl shadow-black/50 backdrop-blur">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-sm">
        <span className="flex items-center gap-2 font-medium">
          <span className="inline-block size-2 animate-pulse rounded-full bg-sky-400" />
          {label}
        </span>
        <span className="tabular-nums text-xs text-neutral-300">{total > 0 ? `${done} / ${total}` : "starting…"}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-neutral-700">
        <div className={`h-2 rounded ${color} transition-all`} style={{ width: `${total > 0 ? pct : 5}%` }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-neutral-400">
        <span>{detail ?? (total > 0 ? `${pct}%` : "")}</span>
        {onStop && (
          <button type="button" className="rounded px-2 py-0.5 text-neutral-200 underline hover:bg-neutral-800" onClick={onStop}>
            {stopLabel}
          </button>
        )}
      </div>
    </div>
  )
}
