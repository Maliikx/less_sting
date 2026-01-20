import { z } from "zod"

export const offerSchema = z.object({
  title: z.string().min(3, "Title is required"),
  link: z.string().url("Invalid URL"),
  price: z.string().min(1, "Price is required"),
})

export const formSchema = z.object({
  employee: z.string().min(1, "Employee is required"),
  offers: z.array(offerSchema).min(1, "At least one offer is required"),
})

export type FormValues = z.infer<typeof formSchema>
