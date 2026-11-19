-- Auditoria D1: toda execução iniciada por outra guarda a execução raiz, para limitar quantas filhas uma raiz pode gerar (ciclo A → B → A).
ALTER TABLE flow_runs ADD COLUMN root_run_id TEXT;
CREATE INDEX flow_runs_root ON flow_runs(root_run_id) WHERE root_run_id IS NOT NULL;
