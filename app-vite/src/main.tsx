// Primeiro import: o Zod dos esquemas do motor fica sem JIT (sem new Function) antes de qualquer parse; a CSP não tem 'unsafe-eval'.
import "../../engine/src/schemas/zod-sem-eval"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "react-router"
import "@fontsource-variable/inter"
import "./globals.css"
import { Toaster } from "@/components/ui/sonner"
import { router } from "./routes"
import { installValidationMessages } from "@/lib/validation-messages"

installValidationMessages()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
    <Toaster />
  </StrictMode>
)
