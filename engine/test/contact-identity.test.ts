import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { getContact, getWhatsappIdentity, getWhatsappIdentityByPhone, upsertWhatsappIdentity } from '../src/db/contacts'
import { seed } from './fixtures'

const sql = (query: string, ...values: (string | number | null)[]) => env.DB.prepare(query).bind(...values)
const bsuid = 'BR.13491208655302741918'
const phone = '+5511999991234'
const input = { contact_id: 'c-a', channel_id: 'wa-a', bsuid }

beforeEach(async () => {
  await seed()
  await env.DB.batch(['a', 'b'].flatMap(ws => ['whatsapp', 'telegram', 'tiktok'].map(type =>
    sql('INSERT INTO channels(id,workspace_id,type,external_id) VALUES(?,?,?,?)',
      `${type === 'whatsapp' ? 'wa' : type === 'telegram' ? 'tg' : type}-${ws}`, ws, type, `${type}-external-${ws}`))))
})

describe('W7 identidade WhatsApp no repositório e D1', () => {
  it('cria sem telefone e mantém chave/contato/opt-in ao ligar, alterar e remover o atributo', async () => {
    const first = await upsertWhatsappIdentity(env.DB, 'a', input)
    expect(first).toMatchObject({ external_user_id: bsuid, identity_kind: 'bsuid', phone_e164: null, opted_in: false })
    await sql('UPDATE contact_channels SET opted_in=1 WHERE id=?', first.id).run()
    const linked = await upsertWhatsappIdentity(env.DB, 'a', { ...input, phone_e164: phone, username: 'nome' })
    expect(linked).toMatchObject({ id: first.id, contact_id: 'c-a', external_user_id: bsuid, phone_e164: phone, opted_in: true })
    expect(await getWhatsappIdentityByPhone(env.DB, 'a', 'wa-a', phone)).toEqual(linked)
    expect(await upsertWhatsappIdentity(env.DB, 'a', input)).toEqual(linked)
    await upsertWhatsappIdentity(env.DB, 'a', { ...input, phone_e164: '+5511999995678' })
    const cleared = await upsertWhatsappIdentity(env.DB, 'a', { ...input, phone_e164: null, username: null })
    expect(cleared).toMatchObject({ id: first.id, external_user_id: bsuid, phone_e164: null, username: null })
    for (const alias of [phone, '+5511999995678']) {
      expect(await getWhatsappIdentityByPhone(env.DB, 'a', 'wa-a', alias)).toEqual(cleared)
    }
    // The profile adds connection metadata; every identity attribute remains unchanged.
    expect((await getContact(env.DB, 'a', 'c-a'))?.channels.find(c => c.id === first.id)).toMatchObject(cleared)
  })

  it('isola todas as novas leituras/escritas e valida os dois pais antes de gravar', async () => {
    const created = await upsertWhatsappIdentity(env.DB, 'a', { ...input, phone_e164: phone })
    expect(await getContact(env.DB, 'b', 'c-a')).toBeNull()
    expect(await getWhatsappIdentity(env.DB, 'b', 'wa-a', bsuid)).toBeNull()
    expect(await getWhatsappIdentityByPhone(env.DB, 'b', 'wa-a', phone)).toBeNull()
    for (const foreign of [input, { ...input, channel_id: 'wa-b' }, { ...input, contact_id: 'c-b' }]) {
      await expect(upsertWhatsappIdentity(env.DB, foreign === input ? 'b' : 'a', foreign)).rejects.toMatchObject({ status: 404 })
    }
    expect(await getWhatsappIdentity(env.DB, 'a', 'wa-a', bsuid)).toEqual(created)
    expect(await sql('SELECT count(*) n FROM contact_identity_aliases').first('n')).toBe(1)
    await expect(getWhatsappIdentity(env.DB, '', 'wa-a', bsuid)).rejects.toMatchObject({ status: 400 })
    await expect(getWhatsappIdentityByPhone(env.DB, '', 'wa-a', phone)).rejects.toMatchObject({ status: 400 })
    await expect(upsertWhatsappIdentity(env.DB, '', input)).rejects.toMatchObject({ status: 400 })
  })

  it('deduplica por canal/BSUID, suporta ENT e não une outro canal pelo telefone', async () => {
    const first = await upsertWhatsappIdentity(env.DB, 'a', { ...input, phone_e164: phone })
    expect((await upsertWhatsappIdentity(env.DB, 'a', input)).id).toBe(first.id)
    const other = await upsertWhatsappIdentity(env.DB, 'b', { ...input, channel_id: 'wa-b', contact_id: 'c-b', phone_e164: phone })
    expect(other.id).not.toBe(first.id)
    await upsertWhatsappIdentity(env.DB, 'a', { ...input, bsuid: 'BR.ENT.parent123' })
    await sql("INSERT INTO contacts(id,workspace_id) VALUES('tg-contact','a')").run()
    await sql("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id) VALUES('tg-cc','a','tg-contact','tg-a',?)", phone).run()
    expect((await getWhatsappIdentityByPhone(env.DB, 'a', 'wa-a', phone))?.contact_id).toBe('c-a')
    expect(await getWhatsappIdentityByPhone(env.DB, 'a', 'tg-a', phone)).toBeNull()
    expect((await getContact(env.DB, 'a', 'tg-contact'))?.channels[0]?.external_user_id).toBe(phone)
  })

  it('não reatribui BSUID/alias e desfaz integralmente uma gravação em conflito', async () => {
    const first = await upsertWhatsappIdentity(env.DB, 'a', { ...input, phone_e164: phone })
    await sql("INSERT INTO contacts(id,workspace_id) VALUES('c-other','a')").run()
    await expect(upsertWhatsappIdentity(env.DB, 'a', { ...input, contact_id: 'c-other' })).rejects.toMatchObject({ status: 409 })
    await expect(upsertWhatsappIdentity(env.DB, 'a', { ...input, contact_id: 'c-other', bsuid: 'BR.other', phone_e164: phone })).rejects.toMatchObject({ status: 409 })
    expect(await getWhatsappIdentity(env.DB, 'a', 'wa-a', 'BR.other')).toBeNull()
    const other = await upsertWhatsappIdentity(env.DB, 'a', { ...input, bsuid: 'BR.other', phone_e164: '+5511999990000' })
    await expect(upsertWhatsappIdentity(env.DB, 'a', { ...input, bsuid: 'BR.other', phone_e164: phone })).rejects.toMatchObject({ status: 409 })
    expect(await getWhatsappIdentity(env.DB, 'a', 'wa-a', 'BR.other')).toEqual(other)
    expect(await getWhatsappIdentity(env.DB, 'a', 'wa-a', bsuid)).toEqual(first)
  })

  it('rejeita telefone/username no lugar de BSUID e telefone fora de E.164', async () => {
    for (const invalid of [phone, '5511999991234', '(11) 99999-1234', '', 'nome', 'BR.', 'BR.a b', `BR.${'a'.repeat(129)}`]) {
      await expect(upsertWhatsappIdentity(env.DB, 'a', { ...input, bsuid: invalid })).rejects.toMatchObject({ status: 400 })
    }
    for (const invalid of ['5511999991234', '+012345678', '+55 11 9999', '+1234567890123456', '']) {
      await expect(upsertWhatsappIdentity(env.DB, 'a', { ...input, phone_e164: invalid })).rejects.toMatchObject({ status: 400 })
    }
    await expect(upsertWhatsappIdentity(env.DB, 'a', { ...input, channel_id: 'tg-a' })).rejects.toMatchObject({ status: 404 })
  })

  it('schema bloqueia insert/update/troca de canal e alias cruzado mesmo sem repositório', async () => {
    for (const [key, kind] of [[phone, 'bsuid'], ['5511999991234', 'bsuid'], [bsuid, 'provider_id'], [bsuid, 'wa_phone_legacy']]) {
      await expect(sql(`INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,identity_kind)
        VALUES('bad','a','c-a','wa-a',?,?)`, key!, kind!).run()).rejects.toThrow()
    }
    const first = await upsertWhatsappIdentity(env.DB, 'a', input)
    for (const query of ["external_user_id='+5511999991234'", "identity_kind='provider_id'", "channel_id='tg-a'", "contact_id='c-b'", "workspace_id='b'"]) {
      await expect(sql(`UPDATE contact_channels SET ${query} WHERE id=?`, first.id).run()).rejects.toThrow()
    }
    await expect(sql("UPDATE contact_channels SET channel_id='wa-a',identity_kind='bsuid',external_user_id=? WHERE id='cc-a'", bsuid).run()).rejects.toThrow()
    await expect(sql("UPDATE channels SET type='whatsapp' WHERE id='ch-a'").run()).rejects.toThrow()
    await expect(sql("UPDATE channels SET type='telegram' WHERE id='wa-a'").run()).rejects.toThrow()
    for (const [ws, channel] of [['b', 'wa-a'], ['a', 'wa-b']]) {
      await expect(sql('INSERT INTO contact_identity_aliases(workspace_id,channel_id,alias_value,contact_channel_id) VALUES(?,?,?,?)', ws!, channel!, phone, first.id).run()).rejects.toThrow()
    }
    await sql('UPDATE contact_channels SET phone_e164=? WHERE id=?', phone, first.id).run()
    await expect(sql('UPDATE contact_identity_aliases SET contact_channel_id=?', first.id).run()).rejects.toThrow()
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
    await sql("DELETE FROM contacts WHERE id='c-a'").run()
    expect(await sql('SELECT count(*) n FROM contact_identity_aliases').first('n')).toBe(0)
  })

  it('contador TikTok aceita somente inteiros 0–10', async () => {
    await sql("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id) VALUES('tk','a','c-a','tiktok-a','tk-user')").run()
    expect(await sql("SELECT window_messages_sent FROM contact_channels WHERE id='tk'").first('window_messages_sent')).toBe(0)
    await sql("UPDATE contact_channels SET window_messages_sent=10 WHERE id='tk'").run()
    for (const invalid of [-1, 11, 1.5]) {
      await expect(sql("UPDATE contact_channels SET window_messages_sent=? WHERE id='tk'", invalid).run()).rejects.toThrow()
    }
  })
})
