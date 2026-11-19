-- Caminho rápido do webhook: o evento é processado na hora (waitUntil) e a fila fica como rede de segurança.
-- claimed_at: quem está processando o evento agora (posse com prazo; vencida, a fila retoma).
ALTER TABLE inbound_events ADD COLUMN claimed_at INTEGER;
-- executor_claimed_at: quem executa a execução (passos em linha no webhook ou a criação do Workflow). Vencida sem Workflow, o cron retoma.
ALTER TABLE flow_runs ADD COLUMN executor_claimed_at INTEGER;
CREATE INDEX flow_runs_inline_stale ON flow_runs (executor_claimed_at) WHERE workflow_created_at IS NULL AND executor_claimed_at IS NOT NULL;
-- Resultado de cada passo executado em linha: o Workflow que assume depois devolve o mesmo resultado em vez de repetir o passo.
CREATE TABLE flow_inline_steps (
  run_id TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, name)
);
