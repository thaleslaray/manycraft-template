-- Passo "Iniciar outra automação" com espera: a execução filha guarda quem a chamou e espera o término.
-- Preenchido só quando o passo escolheu esperar; chamada "sem esperar" fica sem pai.
ALTER TABLE flow_runs ADD COLUMN parent_run_id TEXT;
CREATE INDEX idx_flow_runs_parent ON flow_runs (parent_run_id) WHERE parent_run_id IS NOT NULL;
