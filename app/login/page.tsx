'use client'

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useState } from "react"

export default function LoginPage() {
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")

    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    })

    if (res.ok) {
      window.location.href = "/" // go to app
    } else {
      // Show the server's real reason (wrong password vs. server not configured)
      const data = await res.json().catch(() => null)
      setError(data?.error || `Login failed (error ${res.status})`)
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-neutral-800">
      <form
        onSubmit={handleSubmit}
        className="bg-neutral-700 p-6 rounded-xl flex flex-col gap-4 w-80"
      >
        <h1 className="text-white text-lg ">Enter Password</h1>

        <Input
          type="password"
          className=" bg-neutral-200 text-black "
          placeholder="Password"
          
          value={password}
          onChange={e => setPassword(e.target.value)}
        />

        {error && <p className="text-red-500 text-sm">{error}</p>}

        <Button variant='secondary' className="bg-white text-black  py-2 ">
          Enter
        </Button>
      </form>
    </main>
  )
}
