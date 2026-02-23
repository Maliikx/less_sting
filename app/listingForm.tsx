"use client"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
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

const ListingForm = () => {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null)

  const [dailyCount, setDailyCount] = useState<number | null>(null)
  const [loadingCount, setLoadingCount] = useState(false)

  const [duplicateTitles, setDuplicateTitles] = useState<Record<number, boolean>>({})

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: "onChange",
    defaultValues: {
      employee: "",
      offers: [{ title: "", link: "", price: "" }],
    },
  })

  const { control, handleSubmit, watch, reset } = form

  const selectedEmployee = watch("employee")

  const { fields, append, remove } = useFieldArray({
    control,
    name: "offers",
  })

  /* ------------------ DAILY COUNT ------------------ */
  useEffect(() => {
    if (!selectedEmployee) return

    setLoadingCount(true)
    fetch(`/api/offers/count?employee=${selectedEmployee}`)
      .then(res => res.json())
      .then(data => setDailyCount(data.count))
      .finally(() => setLoadingCount(false))
  }, [selectedEmployee])

  /* ------------------ DUPLICATE TITLE CHECK ------------------ */
  const offers = watch("offers")

  useEffect(() => {
    const titles = offers
      .map(o => o.title.trim())
      .filter(Boolean)
  
    if (!titles.length) return
  
    fetch("/api/offers/check-batch", {
      method: "POST",
      body: JSON.stringify({ titles }),
    })
  }, [offers])
  
  

  /* ------------------ SUBMIT ------------------ */
  const onSubmit = async (values: FormValues) => {
    if (Object.values(duplicateTitles).some(Boolean)) return

    try {
      setIsSubmitting(true)
      setSubmitError(null)
      setSubmitSuccess(null)

      const res = await fetch("/api/offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      })
      
      if (res.status === 409) {
        const data = await res.json()
        setSubmitError(
          `Duplicate titles: ${data.duplicates.join(", ")}`
        )
        return
      }
      
      if (!res.ok) {
        throw new Error("Failed")
      }
      

      setSubmitSuccess("✅ Offers submitted successfully")
      reset()
      setDuplicateTitles({})
    } catch {
      setSubmitError("❌ Something went wrong. Try again.")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <section className="flex   w-full max-w-300 px-[10%] py-20 rounded-2xl items-center justify-center ">
            <Card  className="bg-neutral-700/70 border-0 w-full  ">
              
          <CardHeader className="border-b-neutral-400 border-b">
            <CardTitle className=" text-white">Less Sting Form App</CardTitle>
            <CardDescription>A better more efficient way to list offers</CardDescription>
            <CardAction className=" text-neutral-200">list</CardAction>
          </CardHeader>
          <CardContent>
          <Form {...form}>
                <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-6 w-full">

                  {/* EMPLOYEE SELECT */}
                  <FormField
                    control={control}
                    name="employee"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-neutral-300">Employee</FormLabel>
                        <Select  onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger className="text-neutral-700 bg-neutral-300">
                              <SelectValue placeholder="Select employee" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent className="bg-neutral-200">
                            {["M", "V", "G", "GS", "S", "R"].map(e => (
                              <SelectItem key={e} value={e}>{e}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {!selectedEmployee && (
                    <p className="text-sm text-muted-foreground">
                      Please select an employee to continue
                    </p>
                  )}

                  {selectedEmployee && (
                    <>
                      <p className="text-l text-white">
                        {loadingCount ? "Checking today's submissions..." : `Offers submitted today: ${dailyCount}`}
                      </p>

                      {/* OFFERS */}
                      {fields.map((field, index) => (
                        <div key={field.id} className="border text-white border-neutral-500 bg-neutral-900 p-4 rounded-lg space-y-3">

                          {duplicateTitles[index] && (
                            <p className="text-sm text-red-500">
                              This title already exists
                            </p>
                          )}

                          <FormField
                            control={control}
                            name={`offers.${index}.title`}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Title</FormLabel>
                                <FormControl>
                                  <Input className="border-neutral-600" {...field} placeholder="Offer title" />
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
                                  {/* Input */}
                                  <FormControl>
                                    <Input
                                    className="border-neutral-600"
                                      {...field}
                                      placeholder="0"
                                      
                                    />
                                  </FormControl>

                                  {/* Multiplier Select */}
                                  <Select
                                    onValueChange={(value) => {
                                      field.onChange(value); // fills input
                                    }}
                                  >
                                    <SelectTrigger className="border-neutral-600 w-22.5">
                                      <SelectValue placeholder="x?" />
                                    </SelectTrigger>

                                    <SelectContent>
                                      <SelectItem value="x2.2">x2.2</SelectItem>
                                      <SelectItem value="x2">x2</SelectItem>
                                      <SelectItem value="x1.9">x1.9</SelectItem>
                                      <SelectItem value="x1.8">x1.8</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>

                                <FormMessage />
                              </FormItem>
                            )}
                          />


                          {fields.length > 1 && (
                            <Button className="cursor-pointer" type="button" variant="destructive" onClick={() => remove(index)}>
                              Remove offer
                            </Button>
                          )}
                        </div>
                      ))}

<Button
          
          className="w-full cursor-pointer"
            type="button"
            variant="secondary"
            onClick={() => append({ title: "", link: "", price: "" })}
          >
            ➕ Add another offer
          </Button>
 {/* FEEDBACK */}
 {submitError && <p className="text-red-500">{submitError}</p>}
      {submitSuccess && <p className="text-green-500">{submitSuccess}</p>}

      <Button
        type="submit"
        variant="secondary"
        disabled={
          !selectedEmployee &&
          isSubmitting ||
          Object.values(duplicateTitles).some(Boolean)
        }
        className="bg-white w-full text-black cursor-pointer "
      >
        {isSubmitting ? "Submitting..." : "Submit Offers"}
      </Button>
                    </>
                  )}

                 

                </form>
              </Form>
              
          </CardContent>
          <CardFooter className=" flex-col gap-6 w-full h-full bg-black">
          
          </CardFooter>
        </Card>
            
    </section>
  )
}

export default ListingForm
