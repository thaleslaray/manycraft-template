-- Tipo da transmissão: 'automatic' (as antigas: o motor decide por destinatário), 'in_window' (texto livre, só janela aberta) ou 'promotional' (exige modelo aprovado).
ALTER TABLE broadcasts ADD COLUMN window_kind TEXT NOT NULL DEFAULT 'automatic' CHECK (window_kind IN ('automatic','in_window','promotional'));
