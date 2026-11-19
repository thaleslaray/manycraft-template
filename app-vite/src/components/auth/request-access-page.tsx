import * as React from "react"
import { useParams } from "react-router"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { requestWorkspaceAccess } from "@/data/team"

/** Link "pedir acesso" de um espaço: quem tem conta mas não é membro envia o pedido; o dono aprova em Configurações › Equipe. */
export function RequestAccessPage() {
  const { workspaceId = "" } = useParams()
  const [message, setMessage] = React.useState("")
  const [state, setState] = React.useState<"idle" | "busy" | "sent">("idle")
  const [error, setError] = React.useState("")
  if (state === "sent") return <main className="mx-auto max-w-md p-6"><h1 className="text-lg font-semibold">Pedido enviado</h1><p className="mt-2 text-text-muted">Avisaremos quando o dono do espaço responder. Depois de aprovado, o espaço aparece no seletor de espaços.</p></main>
  return <main className="mx-auto max-w-md space-y-4 p-6">
    <h1 className="text-lg font-semibold">Pedir acesso a este espaço</h1>
    <p className="text-sm text-text-muted">O dono ou um administrador recebe o pedido e escolhe o seu papel.</p>
    <div className="space-y-1"><Label htmlFor="msg">Mensagem (opcional)</Label><Input id="msg" maxLength={500} value={message} onChange={e => setMessage(e.target.value)} /></div>
    {error ? <p role="alert" className="text-sm text-danger">{error} <a className="underline" href="/login">Entrar</a></p> : null}
    <Button loading={state === "busy"} onClick={async () => {
      setState("busy"); setError("")
      try { await requestWorkspaceAccess(workspaceId, message); setState("sent") }
      catch (e) { setError((e as Error).message); setState("idle") }
    }}>Enviar pedido</Button>
  </main>
}
