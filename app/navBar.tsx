"use client"

import Link from "next/link"

export default function NavBar({ active }: { active: "list" | "manage" | "probe" | "auto" }) {
  const logout = async () => {
    await fetch("/api/login", { method: "DELETE" }).catch(() => {})
    window.location.href = "/login"
  }
  const tab = (isActive: boolean) =>
    `px-3 py-1.5 rounded-md text-sm ${isActive ? "bg-white text-black font-semibold" : "text-neutral-300 hover:bg-neutral-600"}`
  return (
    <nav className="flex flex-wrap items-center gap-2 mb-3">
      <Link href="/" className={tab(active === "list")}>New offers</Link>
      <Link href="/auto" className={tab(active === "auto")}>Batch listing</Link>
      <Link href="/manage" className={tab(active === "manage")}>Manage GameBoost offers</Link>
      <button type="button" onClick={logout} className="ml-auto text-xs text-neutral-400 hover:text-white">
        Log out
      </button>
    </nav>
  )
}
