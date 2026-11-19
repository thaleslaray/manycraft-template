import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

const migrations = new URL('../migrations/', import.meta.url)
const w7 = readFileSync(new URL('0008_contact_identity.sql', migrations), 'utf8')

test('W7 migra banco 0001–0006 populado sem apagar ou trocar chaves, timestamps, FTS ou relações', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('PRAGMA foreign_keys=ON')
    for (const name of readdirSync(migrations).filter(n => /^000[1-6]_.*\.sql$/.test(n)).sort()) {
      db.exec(readFileSync(new URL(name, migrations), 'utf8'))
    }
    db.exec(`INSERT INTO workspaces(id,name) VALUES('a','Oficina fictícia');
      INSERT INTO channels(id,workspace_id,type,external_id) VALUES('wa','a','whatsapp','wa-business'),('tg','a','telegram','tg-bot');
      INSERT INTO contacts(id,workspace_id,first_name) VALUES('c','a','Mariana');
      INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in,username,updated_at)
        VALUES('legacy','a','c','wa','5511999991234',1,'nome-legado',1234567890000),('telegram','a','c','tg','12345',1,NULL,1234567890000);
      INSERT INTO tags(id,workspace_id,name) VALUES('tag','a','Interesse');
      INSERT INTO contact_tags(workspace_id,contact_id,tag_id) VALUES('a','c','tag');
      INSERT INTO conversations(id,workspace_id,contact_channel_id) VALUES('conv','a','legacy');
      INSERT INTO messages(id,workspace_id,conversation_id,direction,source,content) VALUES('msg','a','conv','in','contact','{"text":"oi"}');`)
    const tables = ['contacts', 'contact_channels', 'channels', 'tags', 'contact_tags', 'conversations', 'messages']
    const before = Object.fromEntries(tables.map(t => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]))
    db.exec(w7)
    for (const table of tables) {
      const oldColumns = Object.keys(before[table][0])
      const after = db.prepare(`SELECT ${oldColumns.join(',')} FROM ${table} ORDER BY rowid`).all()
      assert.deepEqual(after, before[table], table)
    }
    assert.equal(db.prepare("SELECT identity_kind FROM contact_channels WHERE id='legacy'").get().identity_kind, 'wa_phone_legacy')
    assert.equal(db.prepare("SELECT identity_kind FROM contact_channels WHERE id='telegram'").get().identity_kind, 'provider_id')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(db.prepare("SELECT count(*) n FROM contacts_fts WHERE contacts_fts MATCH 'rian'").get().n, 1)
    assert.throws(() => db.exec("UPDATE contact_channels SET external_user_id='BR.inventado',identity_kind='bsuid' WHERE id='legacy'"), /immutable/)
    // Explicit linkage to an existing contact adds a verified identity; legacy is retained.
    db.exec(`INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,identity_kind,phone_e164)
      VALUES('verified','a','c','wa','BR.13491208655302741918','bsuid','+5511999991234')`)
    assert.equal(db.prepare('SELECT count(*) n FROM contact_channels').get().n, 3)
    assert.equal(db.prepare('SELECT contact_channel_id FROM contact_identity_aliases').get().contact_channel_id, 'verified')
    db.exec("UPDATE contact_channels SET username='novo' WHERE id='legacy'")
    assert.ok(db.prepare("SELECT updated_at FROM contact_channels WHERE id='legacy'").get().updated_at > 1234567890000)
    db.exec("DELETE FROM contacts WHERE id='c'")
    for (const table of ['contact_channels', 'contact_identity_aliases', 'contact_tags', 'conversations', 'messages']) {
      assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0, table)
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { db.close() }
})

test('schema documentado inclui a mesma extensão W7 e rejeita telefone como chave', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('PRAGMA foreign_keys=ON')
    const schema = readFileSync(new URL('../../replica/schema.d1.sql', import.meta.url), 'utf8')
    assert.ok(schema.endsWith(w7))
    db.exec(schema)
    db.exec(`INSERT INTO workspaces(id,name) VALUES('a','Teste');
      INSERT INTO channels(id,workspace_id,type,external_id) VALUES('wa','a','whatsapp','business');
      INSERT INTO contacts(id,workspace_id) VALUES('c','a')`)
    assert.throws(() => db.exec(`INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,identity_kind)
      VALUES('invalid','a','c','wa','5511999991234','bsuid')`), /requires_bsuid/)
    db.exec(`INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,identity_kind)
      VALUES('valid','a','c','wa','BR.ENT.parent123','bsuid')`)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { db.close() }
})
