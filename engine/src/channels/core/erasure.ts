/** SQL: does this stored inbound event belong to the contact channel `cc`? New events carry external_user_id from ingestion;
 * the payload paths cover events stored before that column existed (and providers not yet on the contract). */
export const inboundEventOwnerSql = (event = 'inbound_events', link = 'cc', channel = 'ch') => `(
  ${link}.external_user_id=${event}.external_user_id
  OR (${channel}.type='telegram' AND ${link}.external_user_id=CAST(coalesce(json_extract(${event}.payload,'$.message.from.id'),json_extract(${event}.payload,'$.callback_query.from.id')) AS TEXT))
  OR (${channel}.type='whatsapp' AND ${link}.external_user_id=json_extract(${event}.payload,'$.from_user_id')))`
