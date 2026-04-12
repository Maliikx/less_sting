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
import { useEffect, useState } from "react"
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

import { formSchema, FormValues } from "./schema"
import { Textarea } from "@/components/ui/textarea"

// Helper to match backend normalization exactly
const normalize = (val: string) => val.trim().toLowerCase().replace(/\s+/g, " ");

const ListingForm = () => {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null)
  
  // Initialized to 0 to prevent "NaN"
  const [dailyCount, setDailyCount] = useState<number>(0)
  const [loadingCount, setLoadingCount] = useState(false)
  const [duplicateTitles, setDuplicateTitles] = useState<Record<number, boolean>>({})

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: "onChange",
    defaultValues: {
      employee: "",
      offers: [{ title: "", link: "", price: "", note: "" }],
    },
  })

  const { control, handleSubmit, watch, reset } = form
  const selectedEmployee = watch("employee")
  const { fields, append, remove } = useFieldArray({ control, name: "offers" })

  /* ------------------ DAILY COUNT ------------------ */
  useEffect(() => {
    if (!selectedEmployee) return
    setLoadingCount(true)
    fetch(`/api/offers/count?employee=${selectedEmployee}`)
      .then(res => res.json())
      .then(data => {
        // Ensure we parse as number to avoid NaN
        setDailyCount(Number(data.count) || 0)
      })
      .catch(() => setDailyCount(0))
      .finally(() => setLoadingCount(false))
  }, [selectedEmployee])

  /* ------------------ LIVE DUPLICATE UI CHECK ------------------ */
  const watchedOffers = watch("offers")
  useEffect(() => {
    const titles = watchedOffers.map(o => normalize(o.title)).filter(Boolean)
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
        const map: Record<number, boolean> = {}
        watchedOffers.forEach((offer, i) => {
          map[i] = data.duplicates.includes(normalize(offer.title))
        })
        setDuplicateTitles(map)
      } catch (e) { console.error("Check failed", e) }
    }, 400)

    return () => clearTimeout(timeout)
  }, [watchedOffers])

  /* ------------------ SUBMIT ------------------ */
  const onSubmit = async (values: FormValues) => {
    try {
      setIsSubmitting(true)
      setSubmitError(null)
      setSubmitSuccess(null)

      const res = await fetch("/api/offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      })

      const data = await res.json()

      // Handle server error response
      if (!res.ok) {
        setSubmitError(data.error || "❌ Something went wrong.")
        return
      }

      // 1. Success Message (Handling potentially undefined counts)
      const added = data.addedCount ?? 0;
      const skipped = data.skippedCount ?? 0;
      
      setSubmitSuccess(`✅ ${added} submitted, ${skipped} skipped`)

      // 2. Update Daily Count
      setDailyCount(prev => prev + added)

      // 3. Keep Duplicates in Form and Highlight Red
      const serverDuplicates = data.duplicates || []
      
      // Filter the original submitted values to find which ones the server rejected
      const remainingInForm = values.offers.filter(offer => 
        serverDuplicates.includes(normalize(offer.title))
      )

      // Reset the form with the duplicates (or a fresh field if empty)
      reset({
        employee: values.employee,
        offers: remainingInForm.length > 0 
          ? remainingInForm 
          : [{ title: "", link: "", price: "", note: "" }],
      })

      // Update the red highlight map for the remaining items
      const newDuplicateMap: Record<number, boolean> = {}
      remainingInForm.forEach((_, i) => {
        newDuplicateMap[i] = true 
      })
      setDuplicateTitles(newDuplicateMap)

    } catch (err) {
      setSubmitError("❌ Connection error. Please try again.")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <section className="flex w-full max-w-300 px-[10%] py-20 rounded-2xl items-center justify-center ">
      <Card className="bg-neutral-700/70 border-0 w-full">
        <CardHeader className="border-b-neutral-400 border-b">
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
                        {["M", "Ms", "V", "G", "GS", "S", "R", "I1", "I2"].map(e => (
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

                  {fields.map((field, index) => (
                    <div key={field.id} className="border text-white border-neutral-500 bg-neutral-900 p-4 rounded-lg space-y-3 relative">
                      
                      {duplicateTitles[index] && (
                        <div className="absolute top-2 right-4 text-xs font-bold text-red-400 animate-pulse">
                          ⚠️ DUPLICATE
                        </div>
                      )}

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
                                placeholder="Offer title" 
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={control}
                        name={`offers.${index}.link`}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Link</FormLabel>
                            <FormControl>
                              <Input className="border-neutral-600" {...field} placeholder="https://..." />
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
                              <FormLabel>Price</FormLabel>
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

                      {fields.length > 1 && (
                        <Button className="w-full mt-2" type="button" variant="destructive" size="sm" onClick={() => remove(index)}>
                          Remove this offer
                        </Button>
                      )}
                    </div>
                  ))}

                  <Button
                    className="w-full border-dashed border-2 border-neutral-500 bg-transparent hover:bg-neutral-800"
                    type="button"
                    onClick={() => append({ title: "", link: "", price: "", note: "" })}
                  >
                    ➕ Add another offer
                  </Button>

                  <div className="pt-4 border-t border-neutral-600">
                    {submitError && <p className="text-red-400 bg-red-950/30 p-2 rounded mb-3 text-center text-sm font-medium">{submitError}</p>}
                    {submitSuccess && <p className="text-green-400 bg-green-950/30 p-2 rounded mb-3 text-center text-sm font-medium">{submitSuccess}</p>}

                    <Button
                      type="submit"
                      disabled={!selectedEmployee || isSubmitting}
                      className="bg-white w-full text-black hover:bg-neutral-200 font-bold py-6 text-lg"
                    >
                      {isSubmitting ? "Processing..." : "Submit All Offers"}
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