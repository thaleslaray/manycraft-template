import { useNavigate, useParams } from "react-router"
import { apiRequest, isFakeMode } from "@/data/api"
import { useAsync } from "@/hooks/use-async"
import { settingsKeys } from "@/data/screen-keys"
import { AvatarInitials } from "@/components/ui/avatar-initials"
import { DropdownMenuLabel } from "@/components/ui/dropdown-menu"
import { RowMenu, RowMenuItem } from "@/components/ui/row-menu"

type Installed = { id: string; template_name: string; template_version: number; automation_id: string; automation_name: string | null; automation_exists: number; installed_by: string | null; installed_at: number }

/** Configurações > Modelos instalados: ícone e nome, quem instalou e um ⋮ com a data e a automação que o modelo gerou. */
export const loadInstalledTemplates = async () => isFakeMode() ? [] : (await apiRequest<{ items: Installed[] }>("/automation-templates/installed")).items
export function InstalledTemplates() {
  const { workspace = "" } = useParams()
  const navigate = useNavigate()
  const list = useAsync(loadInstalledTemplates, "installed-templates", { cache: settingsKeys.installed(workspace) })
  const rows = list.data ?? []
  const cols = "md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_2rem]"
  return <section aria-label="Modelos instalados" className="min-w-0">
    <h2 className="sr-only">Modelos instalados</h2>
    {list.loading ? <p role="status" className="text-sm text-text-muted">Carregando…</p>
      : list.error ? <p role="alert" className="text-sm text-danger">Não foi possível carregar os modelos instalados.</p>
      : !rows.length ? <p className="rounded-lg border border-border bg-surface p-5 text-sm text-text-muted">Nenhum modelo instalado ainda. Os modelos ficam em Automações › Novo › Começar de um modelo.</p>
      : <div role="table" aria-label="Modelos instalados" className="overflow-hidden rounded-lg border border-border bg-surface">
        <div role="row" className={`hidden gap-4 border-b border-border px-4 py-3 text-sm md:grid ${cols}`}><span role="columnheader">Nome</span><span role="columnheader">Instalado por</span><span role="columnheader" className="sr-only">Ações</span></div>
        {rows.map(r => <div role="row" key={r.id} className={`grid items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2 text-sm last:border-b-0 ${cols}`}>
          <div role="cell" className="flex min-w-0 items-center gap-2"><AvatarInitials name={r.template_name} className="size-6 text-2xs" /><p className="min-w-0 truncate">{r.template_name} <span className="text-text-muted">v{r.template_version}</span></p></div>
          <div role="cell" className="min-w-0 truncate text-text-muted">{r.installed_by ?? "conta removida"}</div>
          <div role="cell" className="justify-self-end">
            <RowMenu item={`modelo ${r.template_name}`}>
              <DropdownMenuLabel>Instalado em {new Date(r.installed_at).toLocaleString("pt-BR")}</DropdownMenuLabel>
              {r.automation_exists ? <RowMenuItem onSelect={() => navigate(`/${workspace}/automations/${r.automation_id}`)}>Abrir automação criada: {r.automation_name}</RowMenuItem> : <RowMenuItem disabled>Automação excluída</RowMenuItem>}
            </RowMenu>
          </div>
        </div>)}
      </div>}
  </section>
}
