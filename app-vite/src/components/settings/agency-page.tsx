import * as React from "react"
import { toast } from "sonner"
import { apiRequest, isFakeMode } from "@/data/api"
import { useAsync } from "@/hooks/use-async"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type Agency = { profile: { agency_id: string; name: string; website: string | null } | null; clients: { id: string; name: string; role: string; contacts: number; live_automations: number; connections: number }[] }

/** Modo agência: perfil da agência e os espaços de clientes que você administra, com troca rápida. */
export function AgencyPage() {
  const data = useAsync(() => isFakeMode() ? Promise.resolve<Agency>({ profile: null, clients: [] }) : apiRequest<Agency>("/agency"), "agency")
  const [name, setName] = React.useState("")
  const [site, setSite] = React.useState("")
  React.useEffect(() => { if (data.data?.profile) { setName(data.data.profile.name); setSite(data.data.profile.website ?? "") } }, [data.data])
  const open = async (id: string) => { await apiRequest("/workspaces/switch", { method: "POST", body: JSON.stringify({ workspace_id: id }) }); window.location.assign(`/${id}/dashboard`) }
  return <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
    <h1 className="text-xl font-bold">Agência</h1>
    <section className="space-y-3 rounded-lg border border-border bg-surface p-5">
      <h2 className="font-semibold">Perfil da agência</h2>
      <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1"><Label htmlFor="ag-name">Nome</Label><Input id="ag-name" maxLength={120} value={name} onChange={e => setName(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="ag-site">Site</Label><Input id="ag-site" type="url" value={site} onChange={e => setSite(e.target.value)} placeholder="https://" /></div></div>
      {data.data?.profile ? <p className="text-xs text-text-muted">ID da agência: {data.data.profile.agency_id}</p> : null}
      <Button disabled={!name.trim()} onClick={() => apiRequest("/agency", { method: "PUT", body: JSON.stringify({ name: name.trim(), website: site.trim() || null }) }).then(() => { toast.success("Perfil salvo."); data.reload() }).catch((e: Error) => toast.error(e.message))}>Salvar perfil</Button>
    </section>
    <section className="rounded-lg border border-border bg-surface p-5">
      <h2 className="mb-3 font-semibold">Clientes ({data.data?.clients.length ?? 0})</h2>
      <div className="overflow-x-auto"><table className="w-full min-w-[32rem] text-left text-sm"><thead><tr className="border-b border-border text-text-muted"><th className="py-2">Espaço</th><th>Contatos</th><th>Automações no ar</th><th>Conexões</th><th /></tr></thead>
        <tbody>{(data.data?.clients ?? []).map(c => <tr key={c.id} className="border-b border-border last:border-0"><td className="py-2 font-medium">{c.name}</td><td>{c.contacts}</td><td>{c.live_automations}</td><td>{c.connections}</td>
          <td className="text-right"><Button size="sm" variant="secondary" onClick={() => void open(c.id)}>Abrir</Button></td></tr>)}</tbody></table></div>
    </section>
  </div>
}
