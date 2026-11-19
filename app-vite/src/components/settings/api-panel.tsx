import * as React from "react"
import { Copy, ExternalLink } from "lucide-react"
import { toast } from "sonner"
import { createProfileKey, listProfileKeys, revokeProfileKey, scopeLabel, staleWarning, type ProfileKeyScope } from "@/data/profile-keys"
import { generateSettingsToken, revokeSettingsToken, type SettingsSnapshot } from "@/data"
import { useAsync } from "@/hooks/use-async"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SettingsRow, SettingsRows } from "./settings-rows"
import type { Action, Confirm } from "./items-panel"
import { settingsKeys } from "@/data/screen-keys"

/** API: a chave do espaço e a chave do perfil, cada uma em linhas de rótulo, controle e aviso. */
export function ApiPanel({ snapshot, workspace, run, busy, confirm }: { snapshot: SettingsSnapshot; workspace: string; run: Action; busy: boolean; confirm: Confirm }) {
  const [token, setToken] = React.useState<string | null>(null)
  const create = () => run(async () => { setToken(await generateSettingsToken(workspace)) }, "Chave gerada.")
  return <SettingsRows label="API">
      <SettingsRow label="Obtenha a chave API" htmlFor={token ? "generated-token" : undefined} help={<>
        <p>Cuidado: se você gerar outra chave, todos os métodos da API conectados com a atual serão desativados.</p>
        <p className="mt-1">Use <code>Authorization: Bearer chave</code> em <code>/api/public/v1</code> (contatos, tags, campos, automações). O valor completo aparece só uma vez, na geração.{snapshot.api ? ` Chave gerada em ${new Date(snapshot.api.created_at).toLocaleString("pt-BR")}.` : ""}</p>
      </>}>
        <div className="space-y-3">
          {token ? <div className="space-y-3 rounded-md bg-warning-soft p-3">
            <p className="text-sm font-semibold text-warning">Copie agora: este valor não poderá ser consultado novamente.</p>
            <Label htmlFor="generated-token" className="sr-only">Chave recém-gerada</Label>
            <Input id="generated-token" readOnly value={token} className="font-mono" />
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={async () => { try { await navigator.clipboard.writeText(token); toast.success("Chave copiada.") } catch { toast.error("Não foi possível copiar. Selecione a chave e copie pelo teclado.") } }}><Copy className="size-4" aria-hidden="true" />Copiar chave</Button>
              <Button variant="ghost" onClick={() => setToken(null)}>Já guardei a chave</Button>
            </div>
          </div>
            : snapshot.api ? <Input readOnly aria-label="Chave ativa" value={`••••••••••••••••${snapshot.api.last4}`} className="font-mono" />
            : <p className="text-sm text-text-muted">Nenhuma chave ativa. Gere uma para usar a API.</p>}
          <Button loading={busy} onClick={() => snapshot.api ? confirm("Substituir a chave atual?", "A chave anterior será revogada. Guarde o novo valor quando ele aparecer.", async () => { setToken(await generateSettingsToken(workspace)) }) : void create()}>{snapshot.api ? "Gerar outra chave" : "Gerar chave"}</Button>
        </div>
      </SettingsRow>
      <SettingsRow label="Excluir chave API" help="Cuidado: se você revogar a chave, todos os métodos da API conectados serão desativados.">
        <Button variant="secondary" className="border-danger text-danger" disabled={busy || !snapshot.api} onClick={() => confirm("Revogar a chave?", "A referência à chave será removida deste espaço.", async () => { await revokeSettingsToken(workspace); setToken(null) })}>Excluir chave API</Button>
      </SettingsRow>
      <ProfileApiKey workspace={workspace} confirm={confirm} />
    </SettingsRows>
}

/** Chaves do perfil: valem em todos os espaços em que você edita; o espaço vai no cabeçalho x-workspace. Cada uma tem nome e tipo. */
function ProfileApiKey({ workspace, confirm }: { workspace: string; confirm: Confirm }) {
  const keys = useAsync(listProfileKeys, "profile-api-key", { cache: settingsKeys.profileApiKey(workspace) })
  const [token, setToken] = React.useState<string | null>(null)
  const [name, setName] = React.useState("")
  const [scope, setScope] = React.useState<ProfileKeyScope>("read")
  const [working, setWorking] = React.useState(false)
  const [nameError, setNameError] = React.useState<string | null>(null)
  // Um pedido por vez: clicar de novo enquanto cria ou revoga não cria outra chave.
  const act = (p: () => Promise<unknown>, ok: string) => { setWorking(true); return p().then(() => { toast.success(ok); keys.reload() }).catch((e: Error) => toast.error(e.message)).finally(() => setWorking(false)) }
  const create = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) { setNameError("Dê um nome para lembrar onde a chave é usada."); return }
    setNameError(null)
    void act(() => createProfileKey(name, scope).then(r => { setToken(r.token); setName(""); setScope("read") }), "Chave do perfil criada.")
  }
  const list = keys.data ?? []
  return <>
    <SettingsRow label="Chaves do perfil" htmlFor="profile-key-name" help={<>Valem em todos os seus espaços: cada pedido vale com o seu papel no espaço. Use <code>Authorization: Bearer perfil:chave</code> e informe o espaço em <code>x-workspace</code>. Uma chave "Só ler" consulta, mas não muda nada.</>}>
      <div className="space-y-3">
        {token ? <div className="space-y-2 rounded-md bg-warning-soft p-3">
          <p className="text-sm font-semibold text-warning">Copie agora: este valor não aparece de novo.</p>
          <Input readOnly value={token} className="font-mono" aria-label="Chave do perfil criada" />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={async () => { try { await navigator.clipboard.writeText(token); toast.success("Chave copiada.") } catch { toast.error("Não foi possível copiar. Selecione a chave e copie pelo teclado.") } }}><Copy className="size-4" aria-hidden="true" />Copiar chave</Button>
            <Button variant="ghost" onClick={() => setToken(null)}>Já guardei a chave</Button>
          </div>
        </div> : null}
        <form onSubmit={create} className="space-y-3" noValidate>
          <div className="space-y-1">
            <Label htmlFor="profile-key-name">Nome</Label>
            <Input id="profile-key-name" value={name} maxLength={80} placeholder="Ex.: Planilha de vendas" aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? "profile-key-name-error" : undefined} onChange={e => { setName(e.target.value); if (nameError) setNameError(null) }} />
            {nameError ? <p id="profile-key-name-error" role="alert" className="text-xs text-danger">{nameError}</p> : null}
          </div>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">O que a chave pode fazer</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              {(["read", "write"] as const).map(value => <label key={value} className="flex items-center gap-2"><input type="radio" name="profile-key-scope" className="accent-accent" checked={scope === value} onChange={() => setScope(value)} />{scopeLabel(value)}</label>)}
            </div>
          </fieldset>
          <Button type="submit" loading={working}>Criar chave do perfil</Button>
        </form>
      </div>
    </SettingsRow>
    <SettingsRow label="Chaves ativas" help="Revogue as que você não usa mais: quem tiver a chave perde o acesso na hora.">
      {list.length ? <ul aria-label="Chaves do perfil ativas" className="divide-y divide-border rounded-lg border border-border bg-surface">
        {list.map(key => { const warning = staleWarning(key); return <li key={key.id} className="space-y-1 px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold">{key.name || "Chave sem nome"}</span>
            <Button variant="secondary" size="sm" className="border-danger text-danger" disabled={working} onClick={() => confirm(`Revogar a chave "${key.name || "sem nome"}"?`, "Tudo o que usa esta chave para de funcionar.", () => act(() => revokeProfileKey(key.id), "Chave do perfil revogada."))}>Revogar</Button>
          </div>
          <p className="text-xs text-text-muted">{scopeLabel(key.scope)} · final <span className="font-mono">••••{key.last4}</span> · criada em {new Date(key.created_at).toLocaleDateString("pt-BR")} · {key.last_used_at ? `último uso em ${new Date(key.last_used_at).toLocaleDateString("pt-BR")}` : "nunca usada"}</p>
          {warning ? <p className="text-xs font-medium text-warning">{warning}</p> : null}
        </li> })}
      </ul> : <p className="text-sm text-text-muted">{keys.loading ? "Carregando…" : "Nenhuma chave de perfil ativa."}</p>}
    </SettingsRow>
    <SettingsRow label="Documentação" help="Todas as rotas que a chave do perfil abre, com os campos aceitos e exemplos. A seção Formato ManyChat vale para a chave do espaço.">
      <a href="/api/docs" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm font-medium text-accent underline underline-offset-2"><ExternalLink className="size-4" aria-hidden="true" />Ver documentação da API</a>
    </SettingsRow>
  </>
}
