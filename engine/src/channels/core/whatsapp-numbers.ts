/** Union by phone number (D6): one contact per WhatsApp number in a workspace, whichever connection or provider the person writes through.
 * The table whatsapp_numbers is the arbiter: whoever inserts first owns the number, so two first messages racing converge on one contact.
 * Only a number the provider itself asserted gets here; a LID never does, and other channels never do. */
const PHONE = /^\+[1-9]\d{6,14}$/
export const isPhone = (value: unknown): value is string => typeof value === 'string' && PHONE.test(value)

/** A number left behind by an erased contact is free again. */
const releaseErased = (db: D1Database, workspaceId: string, phone: string) => db.prepare(
  `DELETE FROM whatsapp_numbers WHERE workspace_id=? AND phone_e164=? AND contact_id IN (SELECT id FROM contacts WHERE workspace_id=? AND status='deleted')`)
  .bind(workspaceId, phone, workspaceId)

/** The contact that owns `phone`. When nobody does, `candidateContactId` is created and takes it. */
export async function claimNumber(db: D1Database, workspaceId: string, phone: string, candidateContactId: string, connectionId: string,
  firstName: string | null): Promise<string> {
  if (!isPhone(phone)) return candidateContactId
  // Unificação entre canais: quem já tem esse telefone (importado, criado à mão) vira o dono do número em vez de nascer um contato novo.
  const known = await db.prepare(`SELECT id FROM contacts WHERE workspace_id=? AND phone=? AND status<>'deleted'
    AND NOT EXISTS (SELECT 1 FROM whatsapp_numbers WHERE workspace_id=? AND phone_e164=?) LIMIT 1`)
    .bind(workspaceId, phone.slice(1), workspaceId, phone).first<{ id: string }>()
  if (known) candidateContactId = known.id
  await db.batch([
    releaseErased(db, workspaceId, phone),
    db.prepare(`INSERT INTO contacts (id,workspace_id,first_name,optin_source)
      SELECT ?,?,?,'whatsapp' WHERE NOT EXISTS (SELECT 1 FROM whatsapp_numbers WHERE workspace_id=? AND phone_e164=?) ON CONFLICT(id) DO NOTHING`)
      .bind(candidateContactId, workspaceId, firstName, workspaceId, phone),
    db.prepare(`INSERT INTO whatsapp_numbers (workspace_id,phone_e164,contact_id,first_connection_id)
      SELECT ?,?,c.id,? FROM contacts c WHERE c.workspace_id=? AND c.id=? AND c.status<>'deleted' ON CONFLICT DO NOTHING`)
      .bind(workspaceId, phone, connectionId, workspaceId, candidateContactId),
  ])
  const owner = await db.prepare('SELECT contact_id FROM whatsapp_numbers WHERE workspace_id=? AND phone_e164=?').bind(workspaceId, phone).first<{ contact_id: string }>()
  return owner?.contact_id ?? candidateContactId
}

/** Records that `contactId` owns `phone` when nobody does yet (a contact that learned its number after the first message). */
export async function registerNumber(db: D1Database, workspaceId: string, phone: string, contactId: string, connectionId: string): Promise<void> {
  if (!isPhone(phone)) return
  await db.batch([
    releaseErased(db, workspaceId, phone),
    db.prepare(`INSERT INTO whatsapp_numbers (workspace_id,phone_e164,contact_id,first_connection_id)
      SELECT ?,?,c.id,? FROM contacts c WHERE c.workspace_id=? AND c.id=? AND c.status<>'deleted' ON CONFLICT DO NOTHING`)
      .bind(workspaceId, phone, connectionId, workspaceId, contactId),
  ])
}
