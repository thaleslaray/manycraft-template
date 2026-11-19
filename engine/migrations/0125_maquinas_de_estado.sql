-- Máquinas de estado explícitas (conexão de canal, inscrição em sequência, consentimento e bloqueio do contato).
-- As tabelas de transição moram no código: channels/core/connection-state.ts, flow/sequence-state.ts e channels/core/consent.ts.

-- Conexão: hora da última mudança de estado. Um evento do provedor mais velho que ela não muda mais nada.
ALTER TABLE channels ADD COLUMN state_changed_at INTEGER;

-- Conexão desligada pela equipe (ou arquivada) com outra saúde gravada: o "Atualizar conexão" e a troca de credencial numa conexão
-- desativada escreviam connected/pending sem religar. Passa por 'connecting' para o aviso "A conexão parou" não disparar
-- (o gatilho notice_connection_down só olha a saída de 'connected'; a conexão já estava desligada).
UPDATE channels SET connection_state='connecting' WHERE status='disconnected' AND connection_state='connected';
UPDATE channels SET connection_state='disconnected' WHERE status='disconnected' AND connection_state<>'disconnected';

-- O "Atualizar conexão" do e-mail da plataforma (que não tem o que conferir) deixava a conexão "pareando"; volta a conectada.
UPDATE channels SET connection_state='connected' WHERE type='email' AND provider='cloudflare_email' AND status='connected' AND connection_state='connecting';

-- Invariante: desligada ⇒ saúde desligada. Quem tentar escrever outra saúde numa conexão desligada falha alto em vez de contradizer.
CREATE TRIGGER channels_disabled_state BEFORE UPDATE OF connection_state ON channels
WHEN NEW.status='disconnected' AND NEW.connection_state<>'disconnected'
BEGIN SELECT RAISE(ABORT, 'connection_disabled_state'); END;
-- Linha criada já desligada (só dado de teste e importação) entra com a saúde certa.
CREATE TRIGGER channels_disabled_state_insert AFTER INSERT ON channels
WHEN NEW.status='disconnected' AND NEW.connection_state<>'disconnected'
BEGIN UPDATE channels SET connection_state='disconnected' WHERE rowid=NEW.rowid; END;

-- Bloqueio do contato: hora da última mudança (bloqueou ou desbloqueou). Um evento de bloqueio mais velho que ela não vale.
ALTER TABLE contact_channels ADD COLUMN block_changed_at INTEGER;
UPDATE contact_channels SET block_changed_at=blocked_at WHERE blocked_at IS NOT NULL;

-- Inscrição em sequência: "passo em andamento" é pending_run_id e pending_step_id juntos. Quando a execução some (automação apagada
-- de vez, a chave estrangeira põe NULL em pending_run_id), o passo fica sem dono: a inscrição volta a "agendada" a partir do passo
-- seguinte, como um passo cancelado, em vez de guardar um pending_step_id órfão e reenviar o mesmo passo.
CREATE TRIGGER sequence_subscriptions_run_gone AFTER UPDATE OF pending_run_id ON sequence_subscriptions
WHEN NEW.pending_run_id IS NULL AND OLD.pending_run_id IS NOT NULL AND NEW.pending_step_id IS NOT NULL
BEGIN
  UPDATE sequence_subscriptions SET pending_step_id=NULL, next_step=NEW.next_step+1,
    next_at=coalesce(NEW.next_at, CAST(unixepoch('subsec') * 1000 AS INTEGER))
  WHERE sequence_id=NEW.sequence_id AND contact_id=NEW.contact_id;
END;
-- Órfãs já existentes: seguem para o próximo passo publicado com a espera dele contada de agora (mesma regra do `skip` de
-- flow/sequences.ts e do gatilho recriado na 0126); sem próximo passo, terminam (next_at NULL).
UPDATE sequence_subscriptions SET
  next_step=coalesce((SELECT t.position FROM sequence_steps t WHERE t.workspace_id=sequence_subscriptions.workspace_id
      AND t.sequence_id=sequence_subscriptions.sequence_id AND t.status='live'
      AND t.position>coalesce((SELECT p.position FROM sequence_steps p WHERE p.workspace_id=sequence_subscriptions.workspace_id
        AND p.sequence_id=sequence_subscriptions.sequence_id AND p.id=sequence_subscriptions.pending_step_id), sequence_subscriptions.next_step)
      ORDER BY t.position LIMIT 1), next_step+1),
  next_at=(SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) + t.delay_seconds * 1000 FROM sequence_steps t
      WHERE t.workspace_id=sequence_subscriptions.workspace_id AND t.sequence_id=sequence_subscriptions.sequence_id AND t.status='live'
      AND t.position>coalesce((SELECT p.position FROM sequence_steps p WHERE p.workspace_id=sequence_subscriptions.workspace_id
        AND p.sequence_id=sequence_subscriptions.sequence_id AND p.id=sequence_subscriptions.pending_step_id), sequence_subscriptions.next_step)
      ORDER BY t.position LIMIT 1),
  pending_step_id=NULL
  WHERE pending_run_id IS NULL AND pending_step_id IS NOT NULL;
