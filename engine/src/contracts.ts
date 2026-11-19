/**
 * Contrato painel/motor: o formato que a API devolve. Fonte única dos dois lados; o painel lê estes tipos por
 * app-vite/src/data/types.ts (só `import type`: nada daqui entra no pacote do painel nem roda nos testes dele).
 * O repositório converte INTEGER ms, JSON TEXT e booleanos D1 para este formato.
 * Importe só tipos de módulos sem dependência do Worker (channels/kinds, schemas/*, shared/): o typecheck do painel
 * percorre todo arquivo alcançado daqui, e um import de db/ ou channels/types arrastaria o motor inteiro (D1Database etc.).
 */

import type { ChannelType } from "./channels/kinds"
import type { TriggerType } from "../../shared/trigger-types"
import type { Annotation, ButtonAction } from "./schemas/graph"
import type { CardsBlock } from "./schemas/message-cards"
import type { MediaBlock } from "./schemas/message-media"
import type { QuickReplyBlock } from "./schemas/message-quick-replies"
import type { ListBlock } from "./schemas/message-list"
import type { EmailFilter } from "./schemas/system-fields"
export type { ChannelType, TriggerType, Annotation, EmailFilter }

export type Id = string
export type Iso = string // timestamptz em UTC

export type Workspace = {
  id: Id
  name: string
  timezone: string
  created_at: Iso
  updated_at: Iso
}

export type Channel = {
  id: Id
  workspace_id: Id
  type: ChannelType
  external_id: string
  display_name: string | null
  status: "connected" | "disconnected" | "error"
  created_at: Iso
  updated_at: Iso
}

export type ContactStatus = "subscribed" | "unsubscribed" | "deleted"

export type Contact = {
  /** Só na lista paginada: tags do contato e valores dos campos personalizados por id do campo. */
  tags?: { id: Id; name: string }[]
  fields?: Record<Id, unknown>
  /** Todas as conexões do contato recusaram envio por bloqueio (apagou a conversa ou bloqueou a conta). */
  conversation_deleted?: boolean
  email?: string | null
  phone?: string | null
  id: Id
  workspace_id: Id
  first_name: string | null
  last_name: string | null
  gender: string | null
  locale: string | null
  timezone: string | null
  profile_pic_url: string | null
  status: ContactStatus
  optin_source: string | null // 'trigger:<id>' | 'api' | 'import' | 'ad'
  automation_paused_until: Iso | null
  last_input_text: string | null
  subscribed_at: Iso
  last_interaction_at: Iso | null
  /** Origem de anúncio (a primeira mensagem que veio de um anúncio): colunas do contato, nulas quando ele não veio de anúncio. */
  ad_source_id?: string | null
  ad_source_type?: string | null
  ad_headline?: string | null
  ad_click_id?: string | null
  ad_source_url?: string | null
  ad_referred_at?: Iso | null
  created_at: Iso
  updated_at: Iso
}

export type ContactChannel = {
  id: Id
  contact_id: Id
  channel_id: Id
  external_user_id: string
  username: string | null
  opted_in: boolean
  window_expires_at: Iso | null
  human_window_expires_at: Iso | null
}

/** Campos de sistema que só um canal informa (pela consulta de perfil do provedor). Ausente = o provedor não informou. */
export type ChannelFields = { follows_business?: boolean; business_follows_contact?: boolean; verified?: boolean; follower_count?: number }

export type Tag = {
  id: Id
  workspace_id: Id
  name: string
  contact_count: number
  created_at: Iso
}

export type FieldType = "text" | "number" | "date" | "datetime" | "boolean"

export type CustomField = {
  id: Id
  workspace_id: Id
  scope: "contact" | "bot"
  name: string
  type: FieldType
  description: string | null
  bot_value: unknown | null
  created_at: Iso
}

export type ContactFieldValue = { contact_id: Id; field_id: Id; value: unknown }

export type Folder = {
  id: Id
  workspace_id: Id
  parent_id: Id | null
  name: string
  created_at: Iso
}

// ───────── Grafo da automação ─────────

export type NodeType =
  | "trigger"
  | "message"
  | "question"
  | "action"
  | "condition"
  | "randomizer"
  | "smart_delay"
  | "start_automation"
  | "dynamic"
  | "template_message"

/** Bloco dentro de uma mensagem (uma mensagem tem vários, em sequência), no vocabulário que o editor grava.
 * O botão `dynamic` de schemas/graph fica de fora: só o bloco dinâmico o cria, durante a execução, e ele nunca volta ao rascunho. */
export type MessageBlock =
  | CardsBlock
  | MediaBlock
  | QuickReplyBlock
  | ListBlock
  | { kind: "text"; text: string }
  | { kind: "typing"; seconds: number }
  | { kind: "button"; id: Id; label: string; action: { type: "url"; url: string; webview_size?: "full" | "medium" | "compact" } | { type: "go_to_node" } | { type: "start_automation"; automation_id: string }; actions?: ButtonAction[] }

export type GraphNode = {
  id: string
  type: NodeType
  position: { x: number; y: number }
  config: Record<string, unknown>
}

/** Porta nomeada: 'next' | 'then' | 'btn:<id>' | ramo de condição/randomizer. */
export type GraphEdge = { from: string; port: string; to: string }

/** `annotations`: notas adesivas e quadros do canvas; o motor ignora. */
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[]; annotations?: Annotation[] }

export type AutomationStatus = "draft" | "live" | "stopped"

export type Automation = {
  id: Id
  workspace_id: Id
  folder_id: Id | null
  name: string
  status: AutomationStatus
  draft_graph: Graph
  published_version_id: Id | null
  has_unpublished_changes: boolean // "ponto amarelo"
  /** Travada pelo dono/administrador: os demais papéis só leem. */
  locked?: boolean
  /** Com a trava: ações reservadas a dono e administrador, em texto JSON (a coluna sai como está); nulo = todas. */
  locked_actions?: string | null
  deleted_at: Iso | null
  created_at: Iso
  updated_at: Iso
}

export type AutomationVersion = {
  id: Id
  automation_id: Id
  version: number
  graph: Graph
  published_by: Id | null
  created_at: Iso
}

/** Publicação escolhida no gatilho (cópia guardada na config) e item da lista de publicações da conexão. */
export type CommentPost = {
  likes?: number
  comments?: number
  id: string; caption?: string; mediaType?: string; mediaUrl?: string; thumbnailUrl?: string; permalink?: string; publishedAt?: number
}

export type TriggerConfig = {
  target: "all" | "specific" | "next" | "live"
  post_id?: string
  post_snapshot?: CommentPost
  like_comment?: boolean
  include: string[]
  exclude: string[]
  public_replies: string[]
  /** Resposta a story e comentário em Live: condição sobre o texto (a publicação alvo reaproveita post_id e post_snapshot). */
  rule?: "any" | "contains" | "is" | "word" | "begins"
  words?: string[]
  /** Story: pausa antes da primeira resposta e reação de coração. */
  delay_seconds?: 0 | 30 | 60 | 300 | 600
  heart?: boolean
  /** Link de referência: número/Página/usuário, texto pré-preenchido (no canal que aceita), código do link e o endereço pronto (nulo sem endereço ou código). */
  handle?: string
  text?: string
  /** Link de referência: campo de texto que recebe o que vier depois de `--` no ref. */
  payload_field_id?: string
  code?: string
  link?: string | null
}

/** Regras que o painel cria e edita no gatilho de palavra-chave. */
export type TriggerKeywordRule = "is" | "contains" | "starts_with" | "word_match" | "does_not_contain" | "thumbs_up" | "any"
/** `group`: regra-mãe de um gatilho com várias regras (tela de palavras-chave); as filhas trazem parent_id. O painel do gatilho não edita nenhuma das duas. */
export type TriggerKeyword = {
  id: Id; rule: TriggerKeywordRule | "group"; words: string[]; status: "live" | "draft"
  case_sensitive: boolean; parent_id: Id | null; priority: number
}

export type TriggerState = "active" | "draft" | "initial"
export type TriggerRepeatMode = "once" | "every_time" | "once_per_24_hours"

export type Trigger = {
  id: Id
  workspace_id: Id
  automation_id: Id
  channel_id: Id | null
  channel_type?: ChannelType | null
  name: string
  type: TriggerType
  /** Só na rota de gatilhos da automação (AutomationTriggerRow): passo do gatilho no mapa, regras, estado e repetição. */
  node_id?: string | null
  keywords?: TriggerKeyword[]
  state?: TriggerState
  repeat_mode?: TriggerRepeatMode
  /** Gatilho de grupo (conexão que recebe mensagem de grupo): modo e, opcional, o grupo escolhido. */
  audience?: "direct" | "group"; group_match?: "keyword" | "mention" | null; group_thread_id?: string | null; group_subject?: string | null
  config: TriggerConfig
  /** Hotmart, entrada externa, anúncio, direct e carrinho: o que o motor guardou além do nó (eventos, IDs, nome da entrada). */
  external?: Record<string, unknown>
  active: boolean
  created_at: Iso
  updated_at: Iso
}

/** Linha de GET /automations/:id/triggers; também a resposta do PATCH de um gatilho e do POST de palavra-chave, comentário, story e link
 * (os outros tipos, ao criar, devolvem só id, tipo e nome). `enabled` no lugar de `active`; palavra-chave e externos vêm sem config. */
export type AutomationTriggerRow = Omit<Trigger, "active" | "config"> & {
  enabled: boolean
  config?: TriggerConfig
  keywords: TriggerKeyword[]
  state: TriggerState
  repeat_mode: TriggerRepeatMode
}

export type NodeEventType = "sent" | "delivered" | "read" | "clicked" | "entered" | "waiting" | "passed" | "failed"

export type NodeEvent = {
  id: number
  workspace_id: Id
  automation_id: Id
  node_id: string
  button_id: string | null
  contact_id: Id
  flow_run_id: Id | null
  type: NodeEventType
  created_at: Iso
}

// ───────── Contratos das funções (o que as telas enxergam) ─────────

export type AutomationRow = Automation & {
  trigger_summary: string // linguagem natural, gerada da config
  runs: number
  ctr: number | null // 0..1
  delivered?: number
  read?: number
  trigger_count: number
  trigger_type?: TriggerType | null // tipo do primeiro gatilho
  trigger_channel?: string | null // canal da conexão do primeiro gatilho
  /** Miniatura do mapa (publicado, ou rascunho); null quando só há o gatilho. */
  flow_preview?: FlowPreview | null
}

export type FlowPreview = {
  nodes: { id: string; type: string; x: number; y: number }[]
  edges: { from: string; to: string }[]
}

export type AutomationDetail = {
  automation: Automation
  triggers: Trigger[]
  published_version: AutomationVersion | null
}

export type NodeStats = Partial<Record<NodeEventType, number>> & { buttons?: Record<string, number> }

export type AutomationStats = {
  automation_id: Id
  period_days: number
  nodes: Record<string, NodeStats>
  runs: number
  unique_contacts: number
}

export type TriggerInput = {
  id?: Id
  channel_id?: Id | null
  name?: string
  type?: TriggerType
  config: TriggerConfig
  active?: boolean
  repeat_mode?: TriggerRepeatMode
}

export type ContactFilter = {
  search?: string
  tag_id?: Id
  status?: ContactStatus
  channel_type?: ChannelType
  connection_id?: Id
  trigger_id?: Id
  sequence_id?: Id
  email_filter?: EmailFilter
  segment_id?: Id
  contact_filter?: string
}

export type ContactPage = { rows: Contact[]; next_cursor: string | null; total: number }

/** Recorte do perfil da conexão na ficha do contato (db/contacts.ts monta do perfil do canal): quem pode iniciar a conversa, a janela de
 * resposta (null = sem janela) e o descadastro de e-mail. Só campos obrigatórios: se o perfil do canal mudar, o typecheck do motor acusa lá. */
export type ContactConnectionProfile = {
  initiator: "user" | "business_with_template" | "business_with_optin"
  window: { standardHours: number } | null
  email?: { unsubscribe: "marketing" }
}

export type ContactDetail = {
  contact: Contact
  /** `phone_e164`: o telefone em E.164 quando o canal identifica por telefone. */
  channels: (ContactChannel & { channel_type: ChannelType; connection_name?: string | null; channel_fields: ChannelFields; phone_e164: string | null;
    connection_profile?: ContactConnectionProfile })[]
  tags: Tag[]
  field_values: ContactFieldValue[]
}

export type ContactPatch = Partial<
  Pick<Contact, "first_name" | "last_name" | "gender" | "locale" | "timezone" | "status">
>
