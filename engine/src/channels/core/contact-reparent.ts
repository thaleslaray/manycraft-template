/** Identity strategies own lookup indexes; the contact merge keeps every identity key unchanged. */
export function reparentIdentityIndexes(db: D1Database, workspace: string, primaryId: string, secondaryId: string): D1PreparedStatement[] {
  return [
    db.prepare('UPDATE whatsapp_numbers SET contact_id=? WHERE workspace_id=? AND contact_id=?').bind(primaryId, workspace, secondaryId),
    // Reply tokens and interaction history refer to their original message IDs.
    // Reassign the contact while keeping those delivery and correlation keys unchanged.
    ...['email_messages', 'email_events'].map(table => db.prepare(`UPDATE ${table} SET contact_id=? WHERE workspace_id=? AND contact_id=?`).bind(primaryId, workspace, secondaryId)),
  ]
}
