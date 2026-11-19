import * as React from "react"
import { useCan } from "@/hooks/use-role"
import { useNavigate, useParams } from "react-router"
import { BadgeCheck, BadgeX, CircleCheck, CircleHelp, Clock, Download, Fingerprint, GitMerge, MessageCircle, MoreVertical, Pause, Pencil, Trash2, UserRound } from "lucide-react"
import { channelGlyphs } from "@/components/editor/channel-badge"
import { channelLabels } from "@/components/editor/graph"
import { toast } from "sonner"
import { apiRequest, isFakeMode } from "@/data/api"
import {
  getContact,
  createContactTag,
  listFields,
  listTags,
  pauseContact,
  setFieldValue,
  tagContact,
  updateContact,
  type ContactDetail,
  type ContactPatch,
  type CustomField,
} from "@/data"
import { useAsync } from "@/hooks/use-async"
import { cn } from "@/lib/utils"
import { AvatarInitials } from "@/components/ui/avatar-initials"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { TagChip } from "@/components/ui/tag-chip"
import { ContactSequences } from "./sequence-enrollment"
import { DataRequests } from "./data-requests"
import { downloadContactData, MergeContactDialog } from "./contact-portability-dialogs"
import { DeleteContactDialog } from "./delete-contact-dialog"
import { ContactEmailSection } from "./contact-email-section"
import { contactName, statusLabel } from "./contact-name"
import { TagCombobox } from "./tag-combobox"
import { genderOptions, genderValue } from "./gender"

const PAUSE_DAYS = 7

function optinText(src: string | null) {
  if (!src) return "Origem desconhecida"
  if (src.startsWith("trigger:")) return "Gatilho de uma automação"
  return { api: "API", import: "Importação", ad: "Anúncio", email: "E-mail" }[src] ?? src
}

export function ContactProfile({ contactId, onClose, onChanged }: { contactId: string; onClose: () => void; onChanged: () => void }) {
  const { workspace } = useParams() as { workspace: string }
  const [version, setVersion] = React.useState(0)
  const [merging, setMerging] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const detail = useAsync(() => getContact(contactId), `${contactId}|${version}`)
  const allTags = useAsync(() => listTags(workspace), `${workspace}|${version}`)
  const fields = useAsync(() => listFields(workspace), workspace)
  const d = detail.data ?? detail.stale

  const refresh = () => {
    setVersion((v) => v + 1)
    onChanged()
  }
  async function run(fn: () => Promise<unknown>, ok = "Salvo") {
    setBusy(true)
    try {
      await fn()
      toast.success(ok)
      refresh()
      return true
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui salvar.")
      return false
    } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-8 max-h-[min(38rem,calc(100dvh-4rem))] max-w-[50rem] translate-y-0 overflow-y-auto px-6 pt-8 md:px-16">
        <DialogDescription className="sr-only">Perfil do contato: canais, tags e campos.</DialogDescription>
        {detail.error ? (
          <>
            <DialogTitle>Contato</DialogTitle>
            <Banner variant="danger">
              <span className="mr-3">Não consegui abrir este contato.</span>
              <Button size="sm" variant="secondary" onClick={detail.reload}>
                Tentar de novo
              </Button>
            </Banner>
          </>
        ) : !d && detail.loading ? (
          <div aria-busy="true" aria-label="Carregando contato" className="grid gap-6 md:grid-cols-[16rem_1fr]">
            <DialogTitle className="sr-only">Carregando contato</DialogTitle>
            <div className="space-y-3">
              <Skeleton className="size-16 rounded-pill" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
            <div className="space-y-3">
              <Skeleton className="h-7 w-2/3" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          </div>
        ) : d === null || !d ? (
          <>
            <DialogTitle>Contato não encontrado</DialogTitle>
            <p className="text-text-muted">O link pode estar errado ou o contato foi removido.</p>
          </>
        ) : d.contact.status === "deleted" ? (
          <>
            <DialogTitle>Contato sem identificação</DialogTitle>
            <p className="text-sm text-text-muted">Os dados pessoais e as conversas foram excluídos. As estatísticas permanecem preservadas.</p>
          </>
        ) : (
          <fieldset disabled={busy} aria-busy={busy} className="min-w-0"><Body
            key={`${contactId}:${version}`}
            d={d}
            tags={allTags.data ?? allTags.stale ?? []}
            fields={(fields.data ?? []).filter((f) => f.scope === "contact")}
            run={run}
            onDelete={() => setDeleting(true)}
            onMerge={() => setMerging(true)}
            onEmailChanged={refresh}
          /></fieldset>
        )}
      </DialogContent>
      {merging && d ? <MergeContactDialog primary={d} workspace={workspace} onClose={() => setMerging(false)} onDone={() => { setMerging(false); refresh() }} /> : null}
      {deleting && d ? <DeleteContactDialog workspace={workspace} ids={[contactId]} name={contactName(d.contact)} onClose={() => setDeleting(false)} onDeleted={() => { onChanged(); onClose() }} /> : null}
    </Dialog>
  )
}

type Detail = NonNullable<Awaited<ReturnType<typeof getContact>>>

function Body({
  d,
  tags,
  fields,
  run,
  onDelete,
  onEmailChanged,
  onMerge,
}: {
  d: Detail
  onMerge: () => void
  onDelete: () => void
  onEmailChanged: () => void
  tags: { id: string; name: string }[]
  fields: CustomField[]
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>
}) {
  const { workspace } = useParams() as { workspace: string }
  const c = d.contact
  const name = contactName(c)
  const paused = c.automation_paused_until !== null && Date.parse(c.automation_paused_until) > Date.now()
  const patch = (p: ContactPatch) => run(() => updateContact(c.id, p))
  const canEdit = useCan("edit")
  const canPause = useCan("contact:pause")

  const pauseNow = () => void run(() => pauseContact(c.id, paused ? null : new Date(Date.now() + PAUSE_DAYS * 86_400_000).toISOString()), paused ? "Automações retomadas" : `Automações pausadas por ${PAUSE_DAYS} dias`)

  return (
    // Leitor e atendente veem o perfil inteiro; os controles ficam desligados porque o motor recusaria a alteração.
    // Só as colunas de campos ficam travadas; "Abrir conversa" segue a regra do atendimento e "Pausar automação" a ação contact:pause (todo papel menos o leitor).
    <div className="grid min-w-0 gap-6 md:grid-cols-[16rem_1fr] md:gap-0">
      <div className="min-w-0 space-y-5 max-md:order-last md:pr-6">
        {c.profile_pic_url ? <AvatarInitials name={name} src={c.profile_pic_url} className="h-40 w-52 !rounded-md text-5xl md:h-[12.5rem] md:w-64" /> : <div aria-hidden="true" className="grid h-40 w-52 place-items-end justify-items-center overflow-hidden rounded-md bg-accent-soft md:h-[12.5rem] md:w-64"><UserRound className="size-44 translate-y-8 fill-accent/40 stroke-0" /></div>}
        <Button type="button" variant="secondary" className="h-9 w-full" disabled={!canPause} onClick={pauseNow}><Pause className="size-4" aria-hidden="true" />{paused ? "Retomar automação" : "Pausar automação"}</Button>
        {paused ? (
          <p className="text-xs text-warning">{Date.parse(c.automation_paused_until!) >= 253402300799000 ? "Pausadas até retomada manual" : `Pausadas até ${new Date(c.automation_paused_until!).toLocaleDateString("pt-BR")}`}</p>
        ) : null}
        <fieldset disabled={!canEdit} className="min-w-0"><dl className="space-y-3 text-sm">
          <div className="flex items-start gap-2">
            <CircleCheck className={cn("mt-0.5 size-4 shrink-0", c.status === "subscribed" ? "text-success" : "text-text-muted")} aria-hidden="true" />
            <dt className="sr-only">Status</dt>
            <dd className="flex flex-wrap items-center gap-x-1">
              <span className={c.status === "subscribed" ? "text-success" : undefined}>{statusLabel[c.status]}</span>
              {c.status === "subscribed" ? (
                <span className="inline-flex items-center"><span aria-hidden="true">(</span><Button variant="link" size="sm" className="h-auto p-0 text-text-muted" onClick={() => patch({ status: "unsubscribed" })}>
                  Cancelar inscrição
                </Button><span aria-hidden="true">)</span></span>
              ) : c.status === "unsubscribed" ? (
                <Button variant="link" size="sm" className="h-auto p-0" onClick={() => patch({ status: "subscribed" })}>
                  Reinscrever
                </Button>
              ) : null}
            </dd>
          </div>
          <div className="flex items-start gap-2">
            <Clock className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden="true" />
            <div className="min-w-0 flex-1"><dt className="text-text-muted">Hora do contato:</dt>
              <dd>{c.timezone ?? "Desconhecido"}</dd></div>
            <CircleHelp className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden="true"><title>Fuso horário do contato, usado nas esperas até um horário.</title></CircleHelp>
          </div>
          <div className="flex items-start gap-2">
            <Fingerprint className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden="true" />
            <dt className="sr-only">ID</dt>
            <dd className="min-w-0 break-all font-mono text-xs">{c.id}</dd>
          </div>
        </dl></fieldset>
        <OpenConversation contactId={c.id} workspace={workspace} />
        <fieldset disabled={!canEdit} className="min-w-0 space-y-5"><ChannelSubscriptions channels={d.channels} subscribed={c.status === "subscribed"} />
        <section aria-label="Inscrição por conexão" className="space-y-2">
          <h3 className="text-xs font-semibold text-text-muted">Inscrição por conexão</h3>
          {d.channels.map((ch) => (
            <div key={ch.id} className="rounded-md border border-border p-2 text-sm">
              <p className="break-words font-semibold">{ch.connection_name || `Conexão ${ch.channel_id}`}</p>
              <p className={ch.opted_in && c.status === "subscribed" ? "text-success" : "text-text-muted"}>{!ch.opted_in ? "Inscrição cancelada" : c.status === "unsubscribed" ? "Inscrição cancelada" : "Recebimento autorizado"}</p>
              {ch.username ? <p className="truncate text-xs text-text-muted">@{ch.username}</p> : null}
              {ch.connection_profile?.window ? <WindowLines ch={ch} adReferredAt={c.ad_referred_at ?? null} /> : null}
              {ch.connection_profile ? <p className="mt-1 text-xs text-text-muted">{ch.connection_profile.initiator === "user" ? "A pessoa precisa iniciar a conversa." : "Início de conversa sujeito à autorização de recebimento."}{ch.connection_profile.window ? ` Janela de ${ch.connection_profile.window.standardHours} horas após a interação.` : " Sem limite de janela de conversa."}</p> : null}
            </div>
          ))}
          {d.channels.length === 0 ? <p className="text-xs text-text-muted">Nenhuma conexão vinculada.</p> : null}
        </section></fieldset>
      </div>

      <fieldset disabled={!canEdit} className="min-w-0 space-y-4 md:border-l md:border-border md:pl-6 [&>section]:border-b [&>section]:border-border [&>section]:pb-4">
        <div className="flex min-w-0 items-start gap-2 border-b border-border pb-2 pr-8">
          <DialogTitle className="min-w-0 flex-1 text-xl break-words" title={name}>
            {name}
          </DialogTitle>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Mais ações do contato" className="-mt-1 shrink-0"><MoreVertical className="size-5" aria-hidden="true" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => void downloadContactData(c.id)}><Download className="size-4" aria-hidden="true" />Baixar dados (JSON)</DropdownMenuItem>
              <DropdownMenuItem onSelect={onMerge}><GitMerge className="size-4" aria-hidden="true" />Mesclar contato…</DropdownMenuItem>
              <DropdownMenuItem className="text-danger" onSelect={onDelete}><Trash2 className="size-4" aria-hidden="true" />Excluir contato</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <section aria-label="Tags do contato" className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-base font-semibold">Tags do contato</h3>
            <TagCombobox tags={tags} taken={d.tags.map(t => t.id)}
              onPick={t => void run(() => tagContact(c.id, t.id, "add"), `Tag ${t.name} adicionada`)}
              onCreate={name => void run(async () => { const tag = await createContactTag(workspace, name); await tagContact(c.id, tag.id) }, "Tag criada e aplicada")} />
          </div>
          <ul className="flex flex-wrap items-center gap-2">
            {d.tags.map((t) => (
              <li key={t.id}>
                <TagChip variant="removable" label={t.name} onRemove={() => run(() => tagContact(c.id, t.id, "remove"), `Tag ${t.name} removida`)} />
              </li>
            ))}
            {d.tags.length === 0 ? <li className="text-sm text-text-muted">Sem tags</li> : null}
          </ul>
        </section>

        <ContactSequences contactId={c.id} workspace={workspace} />

        <section aria-label="Origem do opt-in" className="space-y-2 text-sm">
          <h3 className="text-base font-semibold">Optou por aderir</h3>
          <p className="inline-block rounded-pill bg-border/40 px-3 py-1 text-xs">{optinText(c.optin_source)}</p>
        </section>

        {c.ad_referred_at ? <section aria-label="Origem do anúncio" className="space-y-1 text-sm">
          <h3 className="text-sm font-semibold">Veio de um anúncio</h3>
          {c.ad_headline && <p className="break-words"><span className="text-text-muted">Anúncio: </span>{c.ad_headline}</p>}
          {c.ad_source_id && <p className="break-all"><span className="text-text-muted">ID do anúncio: </span>{c.ad_source_id}</p>}
          {c.ad_click_id && <p className="break-all"><span className="text-text-muted">Código do clique: </span>{c.ad_click_id}</p>}
          <p><span className="text-text-muted">Chegou em: </span>{new Date(c.ad_referred_at).toLocaleString("pt-BR")}</p>
        </section> : null}

        <section aria-label="Campos do sistema" className="space-y-2">
          <h3 className="text-base font-semibold">Campos do sistema</h3>
          <InlineText label="Primeiro nome" value={c.first_name ?? ""} maxLength={60} onSave={(v) => patch({ first_name: v || null })} />
          <InlineText label="Sobrenome" value={c.last_name ?? ""} maxLength={60} onSave={(v) => patch({ last_name: v || null })} />
          {c.phone && <FieldBox label="Telefone" value={c.phone} />}
          {c.email && <FieldBox label="E-mail" value={c.email} />}
          <InlineText label="Idioma" value={c.locale ?? ""} onSave={(v) => patch({ locale: v || null })} />
          <div className={fieldBox}>
            <span className="text-xs text-text-muted" id="gender-l">Gênero</span>
            <Select value={genderValue(c.gender) ?? "__n"} onValueChange={(v) => patch({ gender: v === "__n" ? null : v })}>
              <SelectTrigger aria-labelledby="gender-l" className="h-7 border-0 bg-transparent px-0 shadow-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {genderOptions.map(o => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}
                <SelectItem value="__n">Não informado</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </section>

        <section aria-label="Campos personalizados" className="space-y-2">
          <h3 className="text-base font-semibold">Campos personalizados</h3>
          {fields.length === 0 ? <p className="text-sm text-text-muted">Nenhum campo criado.</p> : null}
          {fields.map((f) => {
            const v = d.field_values.find((x) => x.field_id === f.id)?.value
            const save = (val: unknown) => run(() => setFieldValue(c.id, f.id, val))
            if (f.type === "boolean")
              return (
                <div key={f.id} className={cn(fieldBox, "flex-row items-center justify-between")}>
                  <span className="truncate text-xs text-text-muted" id={`f-${f.id}`}>{f.name}</span>
                  <Switch aria-labelledby={`f-${f.id}`} checked={v === true} onCheckedChange={(x) => save(x)} />
                </div>
              )
            return (
              <InlineText
                key={f.id}
                label={f.name}
                value={v === undefined || v === null ? "" : String(v)}
                type={f.type === "number" ? "number" : f.type === "date" ? "date" : f.type === "datetime" ? "datetime-local" : "text"}
                onSave={(s) => save(f.type === "number" ? (s === "" ? null : Number(s)) : s === "" ? null : s)}
              />
            )
          })}
        </section>

        <ContactEmailSection contactId={c.id} onChanged={onEmailChanged} />
        <DataRequests contactId={c.id} />
      </fieldset>
    </div>
  )
}

/** Caixa de campo do perfil: rótulo pequeno em cima, valor embaixo. */
const fieldBox = "flex min-h-[2.9rem] flex-col justify-center rounded-xl border border-accent/25 bg-accent-soft px-3 py-1 text-sm"
function FieldBox({ label, value }: { label: string; value: string }) {
  return <div className={fieldBox}><span className="text-xs text-text-muted">{label}</span><span className="break-all">{value}</span></div>
}

/** Valor que vira campo ao clicar: Enter ou sair do campo salva, Esc cancela. */
function InlineText({
  label,
  value,
  onSave,
  type = "text",
  maxLength,
}: {
  label: string
  value: string
  onSave: (v: string) => void
  type?: string
  maxLength?: number
}) {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(value)
  const done = React.useRef(false)
  function finish(save: boolean) {
    if (done.current) return
    done.current = true
    setEditing(false)
    if (save && draft !== value) onSave(draft)
  }
  return editing ? (
    <div className={fieldBox}>
      <span className="text-xs text-text-muted">{label}</span>
      <Input
        autoFocus
        aria-label={label}
        type={type}
        maxLength={maxLength}
        value={draft}
        className="h-7 border-0 bg-transparent px-0 shadow-none"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(true)
          else if (e.key === "Escape") {
            e.stopPropagation()
            finish(false)
          }
        }}
      />
    </div>
  ) : (
    <button
      type="button"
      aria-label={`Editar ${label}: ${value || "vazio"}`}
      onClick={() => {
        done.current = false
        setDraft(value)
        setEditing(true)
      }}
      className={cn(fieldBox, "group w-full text-left")}
    >
      <span className="truncate text-xs text-text-muted" title={label}>{label}</span>
      <span className="flex items-center gap-2"><span className="min-w-0 break-words">{value || <span className="text-text-muted">—</span>}</span>
        <Pencil className="size-3 shrink-0 text-text-muted opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" /></span>
    </button>
  )
}


/** Inscrição, IDs e campos de sistema agrupados por canal: inscrito quando o contato está inscrito e alguma conexão do canal autoriza o recebimento. */
type ChannelRow = Pick<ContactDetail["channels"][number], "channel_type" | "opted_in" | "external_user_id" | "username" | "phone_e164" | "channel_fields">
function ChannelSubscriptions({ channels, subscribed }: { channels: ChannelRow[]; subscribed: boolean }) {
  const byChannel = new Map<string, { opted: boolean; ids: string[]; rows: ChannelRow[] }>()
  for (const ch of channels) {
    const entry = byChannel.get(ch.channel_type) ?? { opted: false, ids: [], rows: [] }
    entry.opted ||= ch.opted_in
    if (!entry.ids.includes(ch.external_user_id)) entry.ids.push(ch.external_user_id)
    entry.rows.push(ch)
    byChannel.set(ch.channel_type, entry)
  }
  if (byChannel.size === 0) return null
  return (
    <section aria-label="Inscrição por canal">
      <h3 className="sr-only">Inscrição por canal</h3>
      <dl className="space-y-3 text-sm">
        {[...byChannel].map(([type, { opted, ids, rows }]) => {
          const name = (channelLabels as Record<string, string>)[type] ?? type, Icon = channelGlyphs[type] ?? MessageCircle, active = opted && subscribed
          return (
            <div key={type} className="space-y-1.5">
              <dt className="flex items-start gap-2">
                {active ? <BadgeCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" /> : <BadgeX className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden="true" />}
                <span className={active ? undefined : "text-text-muted"}>{active ? `Optou pelo ${name}` : `Não optou pelo ${name}`}</span>
              </dt>
              <dd className="flex items-start gap-2 text-xs" aria-label={`ID no ${name}`}>
                <span className="grid size-4 shrink-0 place-items-center rounded-pill bg-accent-soft text-accent" aria-hidden="true"><Icon className="size-2.5" /></span>
                <span className="min-w-0 break-all font-mono">{ids.join(", ")}</span>
              </dd>
              {systemFields(type, rows).map(([label, value]) => (
                <dd key={label} className="flex justify-between gap-2 pl-6 text-xs"><span className="text-text-muted">{label}</span><span className="text-right">{value}</span></dd>
              ))}
            </div>
          )
        })}
      </dl>
    </section>
  )
}

const yesNo = (value: boolean | undefined) => value === undefined ? "Não informado" : value ? "Sim" : "Não"

/** Campos de sistema próprios de cada canal, na ordem em que o perfil mostra. */
function systemFields(type: string, rows: ChannelRow[]): [string, string][] {
  const first = rows[0]
  const username = rows.find(r => r.username)?.username
  const phone = rows.find(r => r.phone_e164)?.phone_e164 ?? (type === "whatsapp" ? first?.external_user_id : null)
  if (type === "instagram") {
    const f = rows.find(r => r.channel_fields && Object.keys(r.channel_fields).length)?.channel_fields ?? {}
    return [
      ["Usuário", username ? `@${username}` : "Não informado"],
      ["Segue a conta", yesNo(f.follows_business)],
      ["A conta segue", yesNo(f.business_follows_contact)],
      ["Conta verificada", yesNo(f.verified)],
      ["Seguidores", f.follower_count === undefined ? "Não informado" : f.follower_count.toLocaleString("pt-BR")],
    ]
  }
  if (type === "telegram") return [["Usuário", username ? `@${username}` : "Não informado"]]
  if (type === "whatsapp") return [["Telefone", phone ?? "Não informado"], ["Código do país", phone ? countryCode(phone) : "Não informado"]]
  if (type === "email") return [["E-mail", first?.external_user_id ?? "Não informado"]]
  if (type === "messenger") return [["ID na página (PSID)", first?.external_user_id ?? "Não informado"]]
  return []
}

/** Código do país do telefone em E.164, pelos prefixos de 1 a 3 dígitos mais comuns. */
function countryCode(phone: string): string {
  const digits = phone.replace(/\D/g, "")
  for (const code of ["1", "7", "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49", "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86", "90", "91", "92", "93", "94", "95", "98", "212", "213", "216", "234", "351", "353", "358", "372", "380", "591", "593", "595", "598", "971", "972"]
    .sort((a, b) => b.length - a.length)) if (digits.startsWith(code)) return `+${code}`
  return "Não identificado"
}

/** Abre a conversa deste contato (cria se ainda não houver) em vez da lista geral. Fica fora do bloqueio de edição: o atendente usa. */
function OpenConversation({ contactId, workspace }: { contactId: string; workspace: string }) {
  const navigate = useNavigate()
  const canReply = useCan("inbox:reply")
  const [busy, setBusy] = React.useState(false)
  return <Button variant="link" className="mt-1 w-full justify-start" disabled={!canReply} loading={busy} onClick={async () => {
    if (isFakeMode()) { void navigate(`/${workspace}/inbox`); return }
    setBusy(true)
    try { const { id } = await apiRequest<{ id: string }>(`/inbox/contacts/${encodeURIComponent(contactId)}/conversation`, { method: "POST", body: "{}" }); void navigate(`/${workspace}/inbox/${encodeURIComponent(id)}`) }
    catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível abrir a conversa.") } finally { setBusy(false) }
  }}>
    <MessageCircle className="size-4" aria-hidden="true" />
    Abrir conversa
  </Button>
}

/** Janelas da conversa por conexão: atendimento (24 h após a última mensagem), atendimento humano e entrada gratuita de anúncio (72 h). */
function WindowLines({ ch, adReferredAt }: { ch: { window_expires_at: string | null; human_window_expires_at: string | null }; adReferredAt: string | null }) {
  const now = Date.now(), when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
  const open = (iso: string | null) => !!iso && Date.parse(iso) > now
  const freeUntil = adReferredAt ? new Date(Date.parse(adReferredAt) + 72 * 3_600_000).toISOString() : null
  return <ul className="mt-1 space-y-0.5 text-xs" aria-label="Janelas da conversa">
    <li className={open(ch.window_expires_at) ? "text-success" : "text-text-muted"}>Janela de atendimento: {open(ch.window_expires_at) ? `aberta até ${when(ch.window_expires_at!)}` : "fechada (só modelo aprovado)"}</li>
    {open(ch.human_window_expires_at) ? <li className="text-success">Atendimento humano: até {when(ch.human_window_expires_at!)}</li> : null}
    {open(freeUntil) ? <li className="text-success">Entrada gratuita por anúncio: até {when(freeUntil!)}</li> : null}
  </ul>
}
