-- Connection layer, F4: encrypted credentials, per-connection webhook secret, archive.
-- Ciphertext and IV are base64 text (see core/crypto.ts), not BLOB, so D1 and the local SQLite shim read them identically.
ALTER TABLE channels ADD COLUMN credentials_ciphertext TEXT;
ALTER TABLE channels ADD COLUMN credentials_iv TEXT CHECK (credentials_iv IS NULL OR length(credentials_iv) = 16);
ALTER TABLE channels ADD COLUMN credentials_key_version INTEGER CHECK (credentials_key_version IS NULL OR credentials_key_version >= 1);
ALTER TABLE channels ADD COLUMN credentials_rotated_at INTEGER;
-- sha-256 hex of the webhook secret: finds the connection of a legacy hook delivery without decrypting every row.
ALTER TABLE channels ADD COLUMN webhook_secret_hash TEXT CHECK (webhook_secret_hash IS NULL OR length(webhook_secret_hash) = 64);
ALTER TABLE channels ADD COLUMN webhook_mode TEXT NOT NULL DEFAULT 'manual' CHECK (webhook_mode IN ('auto','manual'));
ALTER TABLE channels ADD COLUMN webhook_registered_at INTEGER;
ALTER TABLE channels ADD COLUMN status_detail TEXT;
ALTER TABLE channels ADD COLUMN archived_at INTEGER;
CREATE INDEX channels_webhook_secret ON channels (webhook_secret_hash) WHERE webhook_secret_hash IS NOT NULL;

-- Same read-only view, now with the F4 columns; still no credential column.
DROP VIEW connections;
CREATE VIEW connections AS
  SELECT id, workspace_id, type AS kind, provider, external_id, display_name, connection_state AS status,
         status_detail, settings, capabilities_override, webhook_mode, webhook_registered_at, archived_at,
         credentials_rotated_at AS rotated_at, created_at, updated_at
  FROM channels;
