import { useEffect, useState } from "react"
import { listConnections, listConnectionGroups, type Connection, type ConnectionGroup, type GroupMatch, type KeywordInput } from "@/data"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { FieldSelect } from "@/components/ui/field-select"
import { Input } from "@/components/ui/input"

export const groupModes: Record<GroupMatch, string> = { keyword: "Quando a mensagem tiver a palavra", mention: "Só quando mencionarem o número" }

/** "Onde vale" do gatilho de WhatsApp: conversa privada ou grupo. No grupo: a conexão, o modo e (opcional) um grupo só. */
export function KeywordGroupFields({ input, update }: { input: KeywordInput; update: (patch: Partial<KeywordInput>) => void }) {
  const group = input.audience === "group"
  const [connections, setConnections] = useState<Connection[] | null>(null)
  const [groups, setGroups] = useState<ConnectionGroup[]>([])
  const [search, setSearch] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!group || connections) return
    listConnections().then((rows) => setConnections(rows.filter((c) => c.kind === input.channel && c.status === "connected" && c.profile?.groups?.reply)), () => setError("Não consegui listar as conexões."))
  }, [group, connections, input.channel])

  const connectionId = input.connection_id ?? ""
  async function load(term: string) {
    if (!connectionId) { setGroups([]); return }
    setLoading(true); setError("")
    try { setGroups((await listConnectionGroups(connectionId, { search: term })).groups) }
    catch (e) { setGroups([]); setError(e instanceof Error ? e.message : "Não consegui listar os grupos.") }
    finally { setLoading(false) }
  }
  useEffect(() => { if (group) void load(search) }, [group, connectionId]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <FieldSelect id="keyword-audience" label="Onde vale" value={input.audience ?? "direct"} options={[{ value: "direct", label: "Conversa privada" }, { value: "group", label: "Grupo da conexão" }]}
        onChange={(audience) => audience === "group"
          ? update({ audience: "group", group_match: input.group_match ?? "keyword", connection_id: null, group_thread_id: null })
          : update({ audience: "direct", group_match: null, connection_id: null, group_thread_id: null })} />
      {group && <>
        <FieldSelect id="keyword-connection" label="Conexão do grupo" value={connectionId} required placeholder="Escolha o número conectado" options={(connections ?? []).map((c) => ({ value: c.id, label: `${c.displayName ?? c.label} · ${c.label}` }))}
          onChange={(id) => update({ connection_id: id || null, group_thread_id: null })} hint={connections && !connections.length ? "Nenhuma conexão disponível para responder em grupos." : undefined} />
        <FieldSelect id="keyword-group-mode" label="Quando responder" value={input.group_match ?? "keyword"} options={Object.entries(groupModes).map(([value, label]) => ({ value, label }))} onChange={(value) => {
          const mode = value as GroupMatch
          // "Mentioned" may go without words; "word" needs at least one condition.
          update({ group_match: mode, rules: mode === "mention" ? input.rules.filter((r) => r.words.length) : input.rules.length ? input.rules : [{ condition: "contains", words: [] }] })
        }} hint={`${input.group_match === "mention"
          ? "Responde só a mensagem que menciona o número. Sem palavras, qualquer menção responde."
          : "Responde a qualquer mensagem do grupo que tiver a palavra, mesmo sem mencionar o número."} A resposta aparece no próprio grupo.`} />
        <div className="space-y-1">
          <div className="flex gap-2">
            <Input id="keyword-group-search" aria-label="Buscar grupo" placeholder="Buscar pelo nome" value={search} disabled={!connectionId}
              onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void load(search) } }} />
            <Button type="button" variant="secondary" disabled={!connectionId || loading} onClick={() => void load(search)}>Buscar</Button>
          </div>
          <FieldSelect id="keyword-group" label="Grupo" value={input.group_thread_id ?? ""} none="Todos os grupos da conexão" disabled={!connectionId}
            options={[...groups.map((g) => ({ value: g.id, label: g.subject ?? g.externalGroupId })), ...(input.group_thread_id && !groups.some((g) => g.id === input.group_thread_id) ? [{ value: input.group_thread_id, label: "Grupo escolhido antes" }] : [])]}
            onChange={(id) => update({ group_thread_id: id || null })} />
          {loading && <p className="text-xs text-text-muted">Buscando grupos…</p>}
        </div>
        {error && <Banner variant="danger"><span role="alert">{error}</span></Banner>}
        <Banner variant="warning">No grupo a resposta sai só como texto, sem botões, e marca quem escreveu.</Banner>
      </>}
    </div>
  )
}
