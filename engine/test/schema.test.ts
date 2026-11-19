import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { graph, seed } from './fixtures'

const originalTables = [
  'plan_limits', 'workspaces', 'workspace_members', 'channels', 'contacts',
  'contact_channels', 'tags', 'contact_tags', 'custom_fields', 'contact_field_values',
  'segments', 'folders', 'automations', 'automation_versions', 'triggers', 'keywords',
  'trigger_firings', 'rules', 'flow_runs', 'node_events', 'sequences', 'sequence_steps',
  'sequence_subscriptions', 'broadcasts', 'conversations', 'messages', 'inbound_events',
  'message_templates', 'activity_logs',
]

async function tagCount() {
  return env.DB.prepare('SELECT contact_count FROM tags WHERE workspace_id = ? AND id = ?')
    .bind('a', 'tag-a').first<number>('contact_count')
}

async function searchNames(workspaceId: string, query: string) {
  const { results } = await env.DB.prepare(`
    SELECT c.id FROM contacts_fts
    JOIN contacts c ON c.rowid = contacts_fts.rowid
    WHERE c.workspace_id = ? AND contacts_fts MATCH ?
    ORDER BY c.id
  `).bind(workspaceId, query).all<{ id: string }>()
  return results.map((row) => row.id)
}

describe('migração SQLite no D1 local', () => {
  beforeEach(seed)

  it('preserva as 31 tabelas originais e aplica sem violações de FK', async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all<{ name: string }>()
    const tables = results.map((row) => row.name)
    expect(originalTables).toHaveLength(29)
    expect(tables).toEqual(expect.arrayContaining(originalTables))
    expect(tables).toContain('contacts_fts')
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })

  it('gera timestamps inteiros em ms e atualiza updated_at sem recursão', async () => {
    const timestamps = await env.DB.prepare(`
      SELECT created_at, updated_at, typeof(created_at) AS created_type,
        typeof(updated_at) AS updated_type FROM workspaces WHERE id = 'a'
    `).first<{ created_at: number; updated_at: number; created_type: string; updated_type: string }>()
    expect(timestamps).not.toBeNull()
    expect(timestamps!.created_type).toBe('integer')
    expect(timestamps!.updated_type).toBe('integer')
    expect(Number.isInteger(timestamps!.created_at)).toBe(true)
    expect(timestamps!.created_at).toBeGreaterThan(1_700_000_000_000)
    expect(timestamps!.updated_at).toBeGreaterThan(1_700_000_000_000)

    await env.DB.prepare("UPDATE workspaces SET updated_at = 1000 WHERE id = 'a'").run()
    await env.DB.prepare("UPDATE workspaces SET name = 'Nome atualizado' WHERE id = 'a'").run()
    const updated = await env.DB.prepare("SELECT updated_at FROM workspaces WHERE id = 'a'")
      .first<number>('updated_at')
    expect(Number.isInteger(updated)).toBe(true)
    expect(updated).toBeGreaterThan(1_700_000_000_000)
  })

  it('rejeita JSON inválido, arrays fora da forma/limite, booleanos e enums inválidos', async () => {
    await expect(env.DB.prepare("UPDATE automations SET draft_graph = 'invalid' WHERE id = 'auto-a'")
      .run()).rejects.toThrow()
    await expect(env.DB.prepare("UPDATE contact_field_values SET value = 'invalid' WHERE workspace_id = 'a'")
      .run()).rejects.toThrow()
    await expect(env.DB.prepare("UPDATE keywords SET words = '{}' WHERE id = 'key-a'")
      .run()).rejects.toThrow()
    await expect(env.DB.prepare('UPDATE keywords SET words = ? WHERE id = ?')
      .bind(JSON.stringify(Array.from({ length: 11 }, (_, i) => `palavra ${i}`)), 'key-a')
      .run()).rejects.toThrow()
    await expect(env.DB.prepare("UPDATE contact_channels SET opted_in = 2 WHERE id = 'cc-a'")
      .run()).rejects.toThrow()
    await expect(env.DB.prepare("UPDATE contacts SET status = 'unknown' WHERE id = 'c-a'")
      .run()).rejects.toThrow()
    await expect(env.DB.prepare("UPDATE automations SET status = 'unknown' WHERE id = 'auto-a'")
      .run()).rejects.toThrow()
  })

  it('mantém contador de tags em insert, delete e cascata de contato', async () => {
    expect(await tagCount()).toBe(1)
    await env.DB.prepare("DELETE FROM contact_tags WHERE workspace_id = 'a' AND contact_id = 'c-a' AND tag_id = 'tag-a'")
      .run()
    expect(await tagCount()).toBe(0)
    await env.DB.prepare('INSERT INTO contact_tags (workspace_id, contact_id, tag_id) VALUES (?, ?, ?)')
      .bind('a', 'c-a', 'tag-a').run()
    expect(await tagCount()).toBe(1)
    await env.DB.prepare("DELETE FROM contacts WHERE workspace_id = 'a' AND id = 'c-a'").run()
    expect(await tagCount()).toBe(0)
    expect(await env.DB.prepare("SELECT contact_count FROM tags WHERE id = 'tag-b'")
      .first<number>('contact_count')).toBe(1)
  })

  it('rejeita UPDATE de versão e preserva snapshot após mudar draft', async () => {
    const snapshot = JSON.stringify(graph)
    await env.DB.prepare(`
      INSERT INTO automation_versions (id, workspace_id, automation_id, version, graph)
      VALUES ('version-a', 'a', 'auto-a', 1, ?)
    `).bind(snapshot).run()
    await env.DB.prepare("UPDATE automations SET published_version_id = 'version-a', status = 'live' WHERE id = 'auto-a'")
      .run()
    await expect(env.DB.prepare("UPDATE automation_versions SET graph = '{}' WHERE id = 'version-a'")
      .run()).rejects.toThrow(/immutable/)
    await env.DB.prepare("UPDATE automations SET draft_graph = '{\"nodes\":[],\"edges\":[]}', has_unpublished_changes = 1 WHERE id = 'auto-a'")
      .run()
    expect(await env.DB.prepare("SELECT graph FROM automation_versions WHERE id = 'version-a'")
      .first<string>('graph')).toBe(snapshot)
  })

  it('impede FKs entre workspaces em associações, versões e filhos', async () => {
    await expect(env.DB.prepare('INSERT INTO contact_tags (workspace_id, contact_id, tag_id) VALUES (?, ?, ?)')
      .bind('a', 'c-a', 'tag-b').run()).rejects.toThrow()
    await expect(env.DB.prepare(`
      INSERT INTO contact_field_values (workspace_id, contact_id, field_id, value)
      VALUES ('a', 'c-a', 'field-b', '"valor"')
    `).run()).rejects.toThrow()
    await expect(env.DB.prepare(`
      INSERT INTO automation_versions (id, workspace_id, automation_id, version, graph)
      VALUES ('foreign-version', 'a', 'auto-b', 1, ?)
    `).bind(JSON.stringify(graph)).run()).rejects.toThrow()
    await expect(env.DB.prepare("UPDATE keywords SET trigger_id = 'trg-b' WHERE id = 'key-a'")
      .run()).rejects.toThrow()

    await env.DB.prepare(`
      INSERT INTO automation_versions (id, workspace_id, automation_id, version, graph)
      VALUES ('version-b', 'b', 'auto-b', 1, ?)
    `).bind(JSON.stringify(graph)).run()
    await expect(env.DB.prepare("UPDATE automations SET published_version_id = 'version-b' WHERE id = 'auto-a'")
      .run()).rejects.toThrow()
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })

  it('SET NULL remove a pasta mantendo workspace_id obrigatório da automação', async () => {
    await env.DB.prepare("INSERT INTO folders (id, workspace_id, name) VALUES ('folder-a', 'a', 'Pasta')").run()
    await env.DB.prepare("UPDATE automations SET folder_id = 'folder-a' WHERE id = 'auto-a'").run()
    await env.DB.prepare("DELETE FROM folders WHERE workspace_id = 'a' AND id = 'folder-a'").run()
    const row = await env.DB.prepare("SELECT workspace_id, folder_id FROM automations WHERE id = 'auto-a'")
      .first<{ workspace_id: string; folder_id: string | null }>()
    expect(row).toEqual({ workspace_id: 'a', folder_id: null })
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })

  it('deduplica once e permite múltiplos disparos com dedupe_key NULL', async () => {
    const insert = (eventId: string, dedupeKey: string | null) => env.DB.prepare(`
      INSERT INTO trigger_firings (workspace_id, trigger_id, contact_id, external_event_id, dedupe_key)
      VALUES ('a', 'trg-a', 'c-a', ?, ?)
    `).bind(eventId, dedupeKey).run()
    await insert('event-1', 'once')
    await expect(insert('event-2', 'once')).rejects.toThrow()
    await insert('event-3', null)
    await insert('event-4', null)
    expect(await env.DB.prepare("SELECT count(*) AS n FROM trigger_firings WHERE workspace_id = 'a'")
      .first<number>('n')).toBe(3)
    expect(await env.DB.prepare("SELECT count(*) AS n FROM trigger_firings WHERE workspace_id = 'b'")
      .first<number>('n')).toBe(0)
  })

  it('disparo de widget dá ao contato a tag com o nome do gatilho; palavra-chave não dá', async () => {
    const fire = (eventId: string) => env.DB.prepare(`INSERT INTO trigger_firings (workspace_id, trigger_id, contact_id, external_event_id, dedupe_key)
      VALUES ('a', 'trg-a', 'c-a', ?, NULL)`).bind(eventId).run()
    const tags = () => env.DB.prepare(`SELECT t.name, t.contact_count FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = 'c-a' AND t.name LIKE 'promo%'`).all()
    await fire('kw-1')
    expect((await tags()).results).toEqual([])
    await env.DB.prepare("UPDATE triggers SET kind = 'widget', widget_type = 'feed_comment', name = '  Promo Natal IG ' WHERE id = 'trg-a'").run()
    await fire('w-1')
    await fire('w-2')
    expect((await tags()).results).toEqual([{ name: 'promo_natal_ig', contact_count: 1 }])
  })

  it('FTS5 encontra substring e sincroniza update e delete sem misturar workspaces', async () => {
    expect(await searchNames('a', 'rian')).toEqual(['c-a'])
    expect(await searchNames('b', 'rian')).toEqual(['c-b'])
    await env.DB.prepare("UPDATE contacts SET first_name = 'Beatriz' WHERE workspace_id = 'a' AND id = 'c-a'").run()
    expect(await searchNames('a', 'rian')).toEqual([])
    expect(await searchNames('a', 'atriz')).toEqual(['c-a'])
    expect(await searchNames('b', 'rian')).toEqual(['c-b'])
    await env.DB.prepare("DELETE FROM contacts WHERE workspace_id = 'a' AND id = 'c-a'").run()
    expect(await searchNames('a', 'atriz')).toEqual([])
    expect(await searchNames('b', 'rian')).toEqual(['c-b'])
  })
})
