-- Campos de sistema que só existem em um canal (Instagram: segue a conta, a conta segue, verificado, seguidores).
-- Um JSON por vínculo de canal, preenchido pela consulta de perfil do provedor; NULL quando o provedor não informou.
ALTER TABLE contact_channels ADD COLUMN channel_fields TEXT CHECK (channel_fields IS NULL OR json_valid(channel_fields));
