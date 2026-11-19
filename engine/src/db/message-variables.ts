import { adVariables, channelVariables, renderVariables, systemVariables, variableErrors } from '../schemas/message-variables'
import { RepositoryError } from './shared'

export async function validateMessageVariables(db: D1Database, workspace: string, texts: string[]) {
  const fields = await db.prepare("SELECT id,scope FROM custom_fields WHERE workspace_id=?")
    .bind(workspace).all<{ id: string; scope: string }>()
  const ids = new Set(fields.results.filter(f => f.scope === 'contact').map(f => f.id))
  const bots = new Set(fields.results.filter(f => f.scope === 'bot').map(f => f.id))
  const errors = texts.flatMap(text => variableErrors(text, ids, bots))
  if (errors.length) throw new RepositoryError(errors.join(' '), 400)
}

/** Snapshot the contact once for a message; values are never recursively interpreted as variables. */
export async function contactVariableRenderer(db: D1Database, workspace: string, contactId: string, encode?: (value: string) => string) {
  // Quatro leituras independentes: uma ida só, em paralelo.
  const [contact, fields, profile, pageName] = await Promise.all([db.prepare(`SELECT first_name,last_name,ad_headline,ad_source_id,ad_click_id,email,phone,gender,locale,timezone,last_input_text,id,
      subscribed_at,last_interaction_at,last_cart FROM contacts WHERE workspace_id=? AND id=?`)
    .bind(workspace, contactId).first<Record<string, string | number | null>>(),
  db.prepare(`SELECT f.id,f.scope,CASE WHEN f.scope='bot' THEN f.bot_value ELSE v.value END AS value FROM custom_fields f LEFT JOIN contact_field_values v
    ON v.workspace_id=f.workspace_id AND v.field_id=f.id AND v.contact_id=? WHERE f.workspace_id=?`)
    .bind(contactId, workspace).all<{ id: string; scope: string; value: string | null }>(),
  db.prepare(`SELECT NULLIF(username,'') AS username,channel_fields FROM contact_channels WHERE workspace_id=? AND contact_id=?
    ORDER BY channel_fields IS NULL, NULLIF(username,'') IS NULL, id LIMIT 1`).bind(workspace, contactId).first<{ username: string | null; channel_fields: string | null }>(),
  db.prepare('SELECT name FROM workspaces WHERE id=?').bind(workspace).first<string>('name')])
  const dateOf = (value: unknown) => typeof value === 'number' ? new Date(value).toISOString() : value
  const parse = (f: { value: string | null }) => f.value == null ? null : JSON.parse(f.value) as unknown
  const values = new Map(fields.results.filter(f => f.scope === 'contact').map(f => [f.id, parse(f)]))
  const bots = new Map(fields.results.filter(f => f.scope === 'bot').map(f => [f.id, parse(f)]))
  // Perfil do canal: o primeiro vínculo do contato que guarda algum dado informado pelo provedor.
  const profileFields = profile?.channel_fields ? JSON.parse(profile.channel_fields) as Record<string, unknown> : {}
  const channelValue = (field: keyof typeof channelVariables) => {
    const value = field === 'canal_usuario' ? profile?.username : profileFields[channelVariables[field]]
    return typeof value === 'boolean' ? (value ? 'sim' : 'não') : value
  }
  const fullName =[contact?.first_name, contact?.last_name].filter(Boolean).join(' ')
  return (text: string) => renderVariables(text, field => field === 'primeiro_nome' ? contact?.first_name
    : field === 'sobrenome' ? contact?.last_name : field === 'nome_completo' ? fullName : field === 'nome_da_pagina' ? pageName
    : Object.hasOwn(channelVariables, field) ? channelValue(field as keyof typeof channelVariables)
    : Object.hasOwn(adVariables, field) ? contact?.[adVariables[field as keyof typeof adVariables]]
    : Object.hasOwn(systemVariables, field) ? dateOf(contact?.[systemVariables[field as keyof typeof systemVariables]])
    : field.startsWith('bot:') ? bots.get(field.slice(4)) : values.get(field.slice(6)), encode)
}
