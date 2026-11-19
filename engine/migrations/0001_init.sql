-- Réplica de estudo — migração inicial SQLite / Cloudflare D1.
-- Fonte: replica/schema.sql (33 tabelas); tradução conforme architecture-cloudflare.md §5.
-- Diferenças de comportamento em relação ao Postgres:
-- * UUID = TEXT NOT NULL, sem geração no banco; aplicação usa crypto.randomUUID().
-- * Datas = INTEGER UTC em milissegundos; relógio SQL unixepoch('subsec') validado localmente.
-- * Boolean = INTEGER 0/1; JSON/arrays = TEXT com json_valid e json_type para arrays.
-- * RLS/auth.uid/security definer/extensions não existem: repositórios recebem workspaceId.
--   Filhas recebem workspace_id e FKs compostas impedem relações entre workspaces.
--   FKs simples preservam CASCADE/SET NULL; compostas diferidas validam o tenant ao final.
-- * graph_ok/duration_ok/all_len_le, regexp/wa_buttons_ok, domínio dos dias da semana,
--   defaults condicionais de trigger e guardas welcome/template/metas ficam na aplicação.
--   Grafos: validado em engine/src/schemas/graph.ts antes de saveDraft/publish.
--   Os módulos de welcome/templates/metas ainda não integram a fatia T3.
-- * GIN/trigram vira FTS5 trigram external-content com 3 triggers; busca >= 3 caracteres.
--   Export D1 direto com virtual table não é suportado; seguir backup do plano §5.5.10.
-- * updated_at usa triggers AFTER UPDATE não recursivos (timestamp explícito é respeitado).
-- * IDENTITY vira INTEGER PRIMARY KEY AUTOINCREMENT; NULL em UNIQUE continua distinto.
-- * Versões publicadas rejeitam UPDATE, inclusive fora do repositório.
-- * Tabelas futuras Better Auth/api_tokens/button_tokens/messages_archive_index não são
--   inventadas: dependem das respectivas integrações; T3 preserva as 33 tabelas originais.
-- Doc consultada ao vivo: developers.cloudflare.com/d1/sql-api/sql-statements/ e
-- developers.cloudflare.com/d1/sql-api/foreign-keys/ (FTS5, JSON e FKs por padrão).


CREATE TABLE plan_limits (
  plan text NOT NULL primary key check (plan in ('free','essential','pro','business','advanced')),
  active_contacts INTEGER not null,
  inbox_seats INTEGER not null default 0,
  max_channels INTEGER,
  ai_included INTEGER not null default 0 CHECK (ai_included IN (0,1)),
  advanced_automations INTEGER not null default 0 CHECK (advanced_automations IN (0,1)),
  price_month_cents INTEGER not null default 0,
  price_year_month_cents INTEGER,
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

insert into plan_limits (plan, active_contacts, inbox_seats, max_channels, ai_included, advanced_automations, price_month_cents, price_year_month_cents) values
  ('free',        25,    0, 2,    0, 0,    0, null),
  ('essential',  250,    1, 2,    0, 0, 1700, 1400),
  ('pro',       2500,    2, 3,    1,  0, 3900, 2900),
  ('business',  7500,    3, null, 1,  1,  9900, 6900),
  ('advanced', 25000,    3, null, 1,  1, 19900, 13900);

CREATE TABLE workspaces (
  id TEXT NOT NULL primary key,
  name text not null,
  timezone text not null default 'America/Sao_Paulo',
  plan text not null default 'free' references plan_limits(plan),
  overage_limit INTEGER,
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE TABLE workspace_members (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  user_id TEXT not null,
  role text not null default 'administrator'
    check (role in ('owner','administrator','editor','livechat_agent','viewer')),
  can_manage_billing INTEGER not null default 0 CHECK (can_manage_billing IN (0,1)),
  inbox_seat INTEGER not null default 0 CHECK (inbox_seat IN (0,1)),
  conversation_limit INTEGER check (conversation_limit is null or conversation_limit > 0),
  auto_assign INTEGER not null default 0 CHECK (auto_assign IN (0,1)),
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  unique (workspace_id, user_id),
  UNIQUE (workspace_id, id)
);

CREATE TABLE channels (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  type text not null check (type in ('instagram','messenger','whatsapp','telegram','tiktok','sms','email')),
  external_id text not null,
  display_name text,
  access_token_encrypted text,
  status text not null default 'connected' check (status in ('connected','disconnected','error')),
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  unique (type, external_id),
  UNIQUE (workspace_id, id)
);

CREATE TABLE contacts (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  first_name text, last_name text,
  gender text, locale text, timezone text,
  profile_pic_url text,
  status text not null default 'subscribed' check (status in ('subscribed','unsubscribed','visitor')),
  optin_source text,
  automation_paused_until INTEGER,
  last_input_text text,
  subscribed_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  last_interaction_at INTEGER,
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, id)
);

CREATE TABLE contact_channels (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL primary key,
  contact_id TEXT not null references contacts(id) on delete cascade,
  channel_id TEXT not null references channels(id) on delete cascade,
  external_user_id text not null,
  username text,
  opted_in INTEGER not null default 0 CHECK (opted_in IN (0,1)),
  window_expires_at INTEGER,
  human_window_expires_at INTEGER,
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  unique (channel_id, external_user_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE tags (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  name text not null,
  contact_count INTEGER not null default 0,
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  unique (workspace_id, name),
  UNIQUE (workspace_id, id)
);

CREATE TABLE contact_tags (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT not null references contacts(id) on delete cascade,
  tag_id TEXT not null references tags(id) on delete cascade,
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  primary key (contact_id, tag_id),
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, tag_id) REFERENCES tags(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE custom_fields (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  scope text not null default 'contact' check (scope in ('contact','bot')),
  name text not null,
  type text not null check (type in ('text','number','date','datetime','boolean','array')),
  description text,
  bot_value TEXT CHECK (bot_value IS NULL OR json_valid(bot_value)),
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  unique (workspace_id, scope, name),
  UNIQUE (workspace_id, id)
);

CREATE TABLE contact_field_values (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT not null references contacts(id) on delete cascade,
  field_id TEXT not null references custom_fields(id) on delete cascade,
  value TEXT not null CHECK (value IS NULL OR json_valid(value)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  primary key (contact_id, field_id),
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, field_id) REFERENCES custom_fields(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE segments (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  name text not null,
  filter TEXT not null CHECK (filter IS NULL OR json_valid(filter)),
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, id)
);

CREATE TABLE folders (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  parent_id TEXT references folders(id) on delete cascade,
  name text not null,
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, parent_id) REFERENCES folders(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE automations (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  folder_id TEXT references folders(id) on delete set null,
  name text not null,
  status text not null default 'draft' check (status in ('draft','live','stopped')),
  draft_graph TEXT not null default '{"nodes":[],"edges":[]}'  CHECK (draft_graph IS NULL OR json_valid(draft_graph)),
  published_version_id TEXT,
  has_unpublished_changes INTEGER not null default 0 CHECK (has_unpublished_changes IN (0,1)),
  deleted_at INTEGER,
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, folder_id) REFERENCES folders(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (published_version_id) REFERENCES automation_versions(id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id, published_version_id, id) REFERENCES automation_versions(workspace_id, id, automation_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE automation_versions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL primary key,
  automation_id TEXT not null references automations(id) on delete cascade,
  version INTEGER not null,
  graph TEXT not null  CHECK (graph IS NULL OR json_valid(graph)),
  published_by TEXT,
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  unique (automation_id, version),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, automation_id) REFERENCES automations(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, id, automation_id)
);

CREATE TABLE triggers (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  automation_id TEXT not null references automations(id) on delete cascade,
  channel_id TEXT references channels(id) on delete cascade,
  name text not null,
  kind text not null check (kind in (
    'widget','keyword','ai_intent','meta_keyword','rule','external_trigger','another_flow',
    'default_reply','welcome_message','story_mention_reply','ice_breaker','main_menu',
    'cart_reply','follow_reply','follow_welcome')),
  widget_type text check (widget_type in (
    'messenger_ref_url','ads_json','ads','feed_comment','feed_comment_trigger','messenger_code',
    'facebook_shops','instagram_story_reply','instagram_share_to_story_reply',
    'instagram_live_comment_reply','ctwa_trigger','tiktok_ads_ctx')),
  status text not null default 'draft' check (status in ('draft','active','inactive','initial','disabled')),
  repeat_mode text not null default 'once' check (repeat_mode in ('once','every_time','once_per_24_hours')),
  post_scope text check (post_scope in ('specific','next','all')),
  target_post_id text,
  first_level_only INTEGER not null default 1 CHECK (first_level_only IN (0,1)),
  like_comment INTEGER not null default 0 CHECK (like_comment IN (0,1)),
  public_replies TEXT not null default '[]' CHECK (json_valid(public_replies) AND json_type(public_replies) = 'array')
    check (json_array_length(public_replies) <= 8),
  story_auto_like INTEGER not null default 0 CHECK (story_auto_like IN (0,1)),
  delay_seconds INTEGER,
  config TEXT not null default '{}' CHECK (config IS NULL OR json_valid(config)),
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  check ((kind = 'widget') = (widget_type is not null)),
  check (post_scope <> 'specific' or target_post_id is not null),
  check (kind <> 'story_mention_reply'
         or (repeat_mode in ('every_time','once_per_24_hours') and delay_seconds in (0,30,60,300,600))),
  check (kind <> 'follow_reply' or delay_seconds in (300,600)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, automation_id) REFERENCES automations(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE keywords (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  trigger_id TEXT not null references triggers(id) on delete cascade,
  parent_id TEXT references keywords(id) on delete cascade,
  rule text not null check (rule in ('is','contains','starts_with','word_match','does_not_contain','group','thumbs_up','any')),
  words TEXT not null default '[]' check (json_array_length(words) <= 10) CHECK (json_valid(words) AND json_type(words) = 'array'),
  status text not null default 'draft' check (status in ('live','draft')),
  case_sensitive INTEGER not null default 0 CHECK (case_sensitive IN (0,1)),
  is_reserved INTEGER not null default 0 CHECK (is_reserved IN (0,1)),
  priority INTEGER not null,
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  check (rule in ('group','thumbs_up','any') or json_array_length(words) >= 1),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, trigger_id) REFERENCES triggers(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, parent_id) REFERENCES keywords(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE trigger_firings (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_id TEXT not null references triggers(id) on delete cascade,
  contact_id TEXT not null references contacts(id) on delete cascade,
  external_event_id text not null,
  dedupe_key text,
  fired_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  unique (trigger_id, contact_id, dedupe_key),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, trigger_id) REFERENCES triggers(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE rules (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  name text not null default 'New Rule',
  kind text not null check (kind in ('internal_event','datetime_event')),
  event_type text not null check (event_type in (
    'datetime','custom_event_triggered','add_tag','remove_tag','subscribe_sequence','unsubscribe_sequence',
    'change_field_value','change_system_field_value','change_integration_field_value',
    'user_created','new_contact_for_ig_onboarding')),
  event_config TEXT not null default '{}' CHECK (event_config IS NULL OR json_valid(event_config)),
  contact_filter TEXT not null default '{}' CHECK (contact_filter IS NULL OR json_valid(contact_filter)),
  frequency text not null default 'always' check (frequency in ('always','once')),
  status text not null default 'inactive' check (status in ('active','inactive','trash')),
  date_field_id TEXT references custom_fields(id) on delete restrict,
  offset_unit text check (offset_unit in ('seconds','minutes','hours','days','months')),
  offset_value INTEGER,
  action_type text not null check (action_type in ('start_flow','http_request')),
  automation_id TEXT references automations(id) on delete restrict,
  http_request TEXT CHECK (http_request IS NULL OR json_valid(http_request)),
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  check (kind <> 'datetime_event' or (date_field_id is not null and offset_unit is not null and offset_value is not null)),
  check (action_type <> 'start_flow' or automation_id is not null),
  check (action_type <> 'http_request' or http_request is not null),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, date_field_id) REFERENCES custom_fields(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, automation_id) REFERENCES automations(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE flow_runs (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  contact_id TEXT not null references contacts(id) on delete cascade,
  automation_version_id TEXT not null references automation_versions(id) on delete cascade,
  trigger_id TEXT references triggers(id) on delete set null,
  current_node_id text,
  status text not null default 'running' check (status in ('running','waiting_delay','waiting_click','waiting_input','done','failed','cancelled')),
  wait_until INTEGER,
  error text,
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, automation_version_id) REFERENCES automation_versions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, trigger_id) REFERENCES triggers(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE node_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  automation_id TEXT not null references automations(id) on delete cascade,
  node_id text not null,
  button_id text,
  contact_id TEXT not null references contacts(id) on delete cascade,
  flow_run_id TEXT references flow_runs(id) on delete set null,
  type text not null check (type in ('sent','delivered','read','clicked','entered','waiting','passed','failed')),
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, automation_id) REFERENCES automations(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, flow_run_id) REFERENCES flow_runs(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE sequences (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  name text not null,
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, id)
);

CREATE TABLE sequence_steps (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  sequence_id TEXT not null references sequences(id) on delete cascade,
  automation_id TEXT references automations(id) on delete set null,
  position INTEGER not null,
  delay_seconds INTEGER not null default 0 check (delay_seconds >= 0),
  status text not null default 'draft' check (status in ('live','draft')),
  send_type text not null default 'all' check (send_type in ('all','timelimit')),
  from_hour INTEGER check (from_hour between 0 and 24),
  to_hour INTEGER check (to_hour between 0 and 24),
  weekdays TEXT not null default '[]' CHECK (json_valid(weekdays) AND json_type(weekdays) = 'array'),
  notification text not null default 'regular',
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  unique (sequence_id, position),
  check ((send_type = 'all' and from_hour is null and to_hour is null and json_array_length(weekdays) = 0)
      or (send_type = 'timelimit' and from_hour < to_hour and json_array_length(weekdays) >= 1)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, sequence_id) REFERENCES sequences(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, automation_id) REFERENCES automations(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE sequence_subscriptions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sequence_id TEXT not null references sequences(id) on delete cascade,
  contact_id TEXT not null references contacts(id) on delete cascade,
  next_step INTEGER not null default 0,
  next_at INTEGER,
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  primary key (sequence_id, contact_id),
  FOREIGN KEY (workspace_id, sequence_id) REFERENCES sequences(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE broadcasts (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  name text not null,
  channel_id TEXT not null references channels(id) on delete cascade,
  automation_id TEXT references automations(id) on delete set null,
  audience_filter TEXT not null default '{}' CHECK (audience_filter IS NULL OR json_valid(audience_filter)),
  status text not null default 'draft' check (status in ('draft','scheduled','sending','sent','cancelled')),
  scheduled_at INTEGER,
  sent_count INTEGER not null default 0,
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, automation_id) REFERENCES automations(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE conversations (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  contact_channel_id TEXT not null references contact_channels(id) on delete cascade,
  status text not null default 'open' check (status in ('open','closed')),
  assignee_id TEXT references workspace_members(id) on delete set null,
  unread INTEGER not null default 1 CHECK (unread IN (0,1)),
  last_message_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  unique (contact_channel_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, contact_channel_id) REFERENCES contact_channels(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, assignee_id) REFERENCES workspace_members(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE messages (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL primary key,
  conversation_id TEXT not null references conversations(id) on delete cascade,
  direction text not null check (direction in ('in','out')),
  source text not null check (source in ('contact','automation','human','broadcast')),
  external_message_id text,
  content TEXT not null CHECK (content IS NULL OR json_valid(content)),
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE inbound_events (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text primary key,
  channel_id TEXT references channels(id) on delete cascade,
  payload TEXT not null CHECK (payload IS NULL OR json_valid(payload)),
  processed_at INTEGER,
  received_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE wallets (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  type text not null default 'debit' check (type in ('debit','credit')),
  currency text not null default 'USD',
  balance_cents INTEGER not null default 0,
  auto_refill_enabled INTEGER not null default 0 CHECK (auto_refill_enabled IN (0,1)),
  refill_amount_cents INTEGER check (refill_amount_cents is null or refill_amount_cents > 0),
  trigger_amount_cents INTEGER,
  daily_limit_cents INTEGER,
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  unique (workspace_id, type),
  check (not auto_refill_enabled or (refill_amount_cents is not null and trigger_amount_cents is not null)),
  UNIQUE (workspace_id, id)
);

CREATE TABLE wallet_transactions (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  wallet_id TEXT not null references wallets(id) on delete cascade,
  amount_cents INTEGER not null,
  currency text not null default 'USD',
  reason text not null,
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, wallet_id) REFERENCES wallets(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE message_templates (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  channel_id TEXT not null references channels(id) on delete cascade,
  group_id TEXT not null,
  language_code text not null,
  is_default INTEGER not null default 0 CHECK (is_default IN (0,1)),
  name_human text not null check (length(name_human) <= 512),
  category text not null default 'utility' check (category in ('utility','marketing','authentication')),
  status text not null default 'pending' check (status in ('pending','disabled','approved','rejected','deleted')),
  header_type text not null default 'none' check (header_type in ('none','text','image')),
  header_text text check (header_text is null or length(header_text) <= 40),
  header_media_url text,
  body text not null check (length(body) <= 1024),
  buttons TEXT not null default '[]' CHECK (buttons IS NULL OR json_valid(buttons)),
  example TEXT not null default '{}' CHECK (example IS NULL OR json_valid(example)),
  last_edited_at INTEGER,
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  unique (group_id, language_code),
  check (header_type <> 'text' or header_text is not null),
  check (header_type <> 'image' or header_media_url is not null),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE ai_goals (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  type text not null check (type in ('lead_gen','lead_qual','grow_followers')),
  status text not null default 'stopped' check (status in ('active','stopped')),
  data TEXT not null default '{}' CHECK (data IS NULL OR json_valid(data)),
  exit_action_type text check (exit_action_type in ('skip','send_message','start_flow','assign_conversation')),
  exit_automation_id TEXT references automations(id) on delete set null,
  exit_assignee_id TEXT references workspace_members(id) on delete set null,
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, exit_automation_id) REFERENCES automations(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, exit_assignee_id) REFERENCES workspace_members(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE ai_knowledge_entries (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  type text not null check (type in ('link','text')),
  state text not null default 'in_process' check (state in ('in_process','processed','failed')),
  title text not null check (length(title) <= 60),
  body text check (body is null or length(body) between 5 and 250000),
  url text check (url is null or length(url) <= 2000),
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  check (type <> 'text' or body is not null),
  check (type <> 'link' or url is not null),
  UNIQUE (workspace_id, id)
);

CREATE TABLE activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  actor_id TEXT,
  action text not null,
  target text,
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, id)
);

CREATE INDEX workspace_members_lookup_1 ON workspace_members (user_id);

create unique index workspace_members_one_owner on workspace_members (workspace_id) where role = 'owner';

CREATE INDEX channels_lookup_3 ON channels (workspace_id);

CREATE INDEX contacts_lookup_4 ON contacts (workspace_id, subscribed_at desc);

CREATE INDEX contacts_lookup_5 ON contacts (workspace_id, last_interaction_at desc);

CREATE INDEX contact_channels_lookup_7 ON contact_channels (contact_id);

CREATE INDEX contact_tags_lookup_8 ON contact_tags (tag_id);

CREATE INDEX contact_field_values_lookup_9 ON contact_field_values (field_id);

CREATE INDEX segments_lookup_10 ON segments (workspace_id);

CREATE INDEX folders_lookup_11 ON folders (workspace_id, parent_id);

CREATE INDEX automations_lookup_12 ON automations (workspace_id, folder_id) where deleted_at is null;

CREATE INDEX triggers_lookup_13 ON triggers (workspace_id);

CREATE INDEX triggers_lookup_14 ON triggers (channel_id, kind) where status = 'active';

CREATE INDEX triggers_lookup_15 ON triggers (automation_id);

create unique index triggers_one_next_post on triggers (channel_id) where post_scope = 'next' and status = 'active';

CREATE INDEX keywords_lookup_17 ON keywords (workspace_id, priority);

CREATE INDEX keywords_lookup_18 ON keywords (trigger_id);

CREATE INDEX keywords_lookup_19 ON keywords (parent_id);

CREATE INDEX trigger_firings_lookup_20 ON trigger_firings (contact_id);

CREATE INDEX rules_lookup_21 ON rules (workspace_id, status);

CREATE INDEX rules_lookup_22 ON rules (date_field_id);

CREATE INDEX rules_lookup_23 ON rules (automation_id);

CREATE INDEX flow_runs_lookup_24 ON flow_runs (contact_id, status);

CREATE INDEX flow_runs_lookup_25 ON flow_runs (status, wait_until) where status = 'waiting_delay';

CREATE INDEX node_events_lookup_26 ON node_events (automation_id, node_id, type);

create unique index node_events_once on node_events (flow_run_id, node_id, coalesce(button_id,''), type);

CREATE INDEX sequences_lookup_28 ON sequences (workspace_id);

CREATE INDEX sequence_steps_lookup_29 ON sequence_steps (workspace_id);

CREATE INDEX sequence_steps_lookup_30 ON sequence_steps (automation_id);

CREATE INDEX sequence_subscriptions_lookup_31 ON sequence_subscriptions (next_at);

CREATE INDEX broadcasts_lookup_32 ON broadcasts (workspace_id, status);

CREATE INDEX broadcasts_lookup_33 ON broadcasts (scheduled_at) where status = 'scheduled';

CREATE INDEX conversations_lookup_34 ON conversations (workspace_id, status, last_message_at desc);

CREATE INDEX conversations_lookup_35 ON conversations (assignee_id);

CREATE INDEX messages_lookup_36 ON messages (conversation_id, created_at desc);

create unique index messages_external_once on messages (external_message_id) where external_message_id is not null;

CREATE INDEX wallet_transactions_lookup_38 ON wallet_transactions (workspace_id, created_at desc);

CREATE INDEX wallet_transactions_lookup_39 ON wallet_transactions (wallet_id);

CREATE INDEX message_templates_lookup_40 ON message_templates (workspace_id, status);

CREATE INDEX message_templates_lookup_41 ON message_templates (channel_id);

create unique index message_templates_one_default on message_templates (group_id) where is_default;

CREATE INDEX ai_goals_lookup_43 ON ai_goals (workspace_id, status);

CREATE INDEX ai_goals_lookup_44 ON ai_goals (exit_automation_id);

CREATE INDEX ai_goals_lookup_45 ON ai_goals (exit_assignee_id);

CREATE INDEX ai_knowledge_entries_lookup_46 ON ai_knowledge_entries (workspace_id, state);

CREATE INDEX activity_logs_lookup_47 ON activity_logs (workspace_id, created_at desc);

CREATE INDEX contacts_cursor ON contacts (workspace_id, subscribed_at DESC, id DESC);

CREATE INDEX activity_logs_workspace ON activity_logs (workspace_id);

CREATE INDEX ai_goals_workspace ON ai_goals (workspace_id);

CREATE INDEX ai_knowledge_entries_workspace ON ai_knowledge_entries (workspace_id);

CREATE INDEX automation_versions_workspace ON automation_versions (workspace_id);

CREATE INDEX automations_workspace ON automations (workspace_id);

CREATE INDEX broadcasts_workspace ON broadcasts (workspace_id);

CREATE INDEX channels_workspace ON channels (workspace_id);

CREATE INDEX contact_channels_workspace ON contact_channels (workspace_id);

CREATE INDEX contact_field_values_workspace ON contact_field_values (workspace_id);

CREATE INDEX contact_tags_workspace ON contact_tags (workspace_id);

CREATE INDEX contacts_workspace ON contacts (workspace_id);

CREATE INDEX conversations_workspace ON conversations (workspace_id);

CREATE INDEX custom_fields_workspace ON custom_fields (workspace_id);

CREATE INDEX flow_runs_workspace ON flow_runs (workspace_id);

CREATE INDEX folders_workspace ON folders (workspace_id);

CREATE INDEX inbound_events_workspace ON inbound_events (workspace_id);

CREATE INDEX keywords_workspace ON keywords (workspace_id);

CREATE INDEX message_templates_workspace ON message_templates (workspace_id);

CREATE INDEX messages_workspace ON messages (workspace_id);

CREATE INDEX node_events_workspace ON node_events (workspace_id);

CREATE INDEX rules_workspace ON rules (workspace_id);

CREATE INDEX segments_workspace ON segments (workspace_id);

CREATE INDEX sequence_steps_workspace ON sequence_steps (workspace_id);

CREATE INDEX sequence_subscriptions_workspace ON sequence_subscriptions (workspace_id);

CREATE INDEX sequences_workspace ON sequences (workspace_id);

CREATE INDEX tags_workspace ON tags (workspace_id);

CREATE INDEX trigger_firings_workspace ON trigger_firings (workspace_id);

CREATE INDEX triggers_workspace ON triggers (workspace_id);

CREATE INDEX wallet_transactions_workspace ON wallet_transactions (workspace_id);

CREATE INDEX wallets_workspace ON wallets (workspace_id);

CREATE INDEX workspace_members_workspace ON workspace_members (workspace_id);


CREATE VIRTUAL TABLE contacts_fts USING fts5(
  first_name, last_name, content='contacts', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER contacts_fts_insert AFTER INSERT ON contacts BEGIN
  INSERT INTO contacts_fts(rowid, first_name, last_name) VALUES (NEW.rowid, NEW.first_name, NEW.last_name);
END;
CREATE TRIGGER contacts_fts_delete AFTER DELETE ON contacts BEGIN
  INSERT INTO contacts_fts(contacts_fts, rowid, first_name, last_name) VALUES ('delete', OLD.rowid, OLD.first_name, OLD.last_name);
END;
CREATE TRIGGER contacts_fts_update AFTER UPDATE OF first_name, last_name ON contacts BEGIN
  INSERT INTO contacts_fts(contacts_fts, rowid, first_name, last_name) VALUES ('delete', OLD.rowid, OLD.first_name, OLD.last_name);
  INSERT INTO contacts_fts(rowid, first_name, last_name) VALUES (NEW.rowid, NEW.first_name, NEW.last_name);
END;
CREATE TRIGGER contact_tags_count_insert AFTER INSERT ON contact_tags BEGIN
  UPDATE tags SET contact_count = contact_count + 1 WHERE workspace_id = NEW.workspace_id AND id = NEW.tag_id;
END;
CREATE TRIGGER contact_tags_count_delete AFTER DELETE ON contact_tags BEGIN
  UPDATE tags SET contact_count = contact_count - 1 WHERE workspace_id = OLD.workspace_id AND id = OLD.tag_id;
END;
CREATE TRIGGER automation_versions_immutable BEFORE UPDATE ON automation_versions BEGIN
  SELECT RAISE(ABORT, 'automation versions are immutable');
END;

CREATE TRIGGER plan_limits_updated AFTER UPDATE ON plan_limits
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE plan_limits SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE plan = NEW.plan;
END;

CREATE TRIGGER workspaces_updated AFTER UPDATE ON workspaces
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE workspaces SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER workspace_members_updated AFTER UPDATE ON workspace_members
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE workspace_members SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER channels_updated AFTER UPDATE ON channels
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE channels SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER contacts_updated AFTER UPDATE ON contacts
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE contacts SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER contact_channels_updated AFTER UPDATE ON contact_channels
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE contact_channels SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER tags_updated AFTER UPDATE ON tags
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE tags SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER custom_fields_updated AFTER UPDATE ON custom_fields
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE custom_fields SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER contact_field_values_updated AFTER UPDATE ON contact_field_values
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE contact_field_values SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER segments_updated AFTER UPDATE ON segments
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE segments SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER folders_updated AFTER UPDATE ON folders
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE folders SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER automations_updated AFTER UPDATE ON automations
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE automations SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER triggers_updated AFTER UPDATE ON triggers
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE triggers SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER keywords_updated AFTER UPDATE ON keywords
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE keywords SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER rules_updated AFTER UPDATE ON rules
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE rules SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER flow_runs_updated AFTER UPDATE ON flow_runs
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE flow_runs SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER sequences_updated AFTER UPDATE ON sequences
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE sequences SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER sequence_steps_updated AFTER UPDATE ON sequence_steps
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE sequence_steps SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER broadcasts_updated AFTER UPDATE ON broadcasts
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE broadcasts SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER conversations_updated AFTER UPDATE ON conversations
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE conversations SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER wallets_updated AFTER UPDATE ON wallets
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE wallets SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER message_templates_updated AFTER UPDATE ON message_templates
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE message_templates SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER ai_goals_updated AFTER UPDATE ON ai_goals
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE ai_goals SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER ai_knowledge_entries_updated AFTER UPDATE ON ai_knowledge_entries
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE ai_knowledge_entries SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;
