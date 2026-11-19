-- Connection layer, F2 (WhatsApp): the delivery state of a WhatsApp message lives in the shared column, like every other channel.
-- Receipts used to be kept only inside the message JSON ($.whatsappStatus); readers (broadcast metrics) can now ask the column.
-- The JSON key keeps being written, so nothing that reads it changes.
UPDATE messages SET delivery_status = json_extract(content, '$.whatsappStatus')
WHERE json_extract(content, '$.whatsappStatus') IN ('sent', 'delivered', 'read', 'failed');
