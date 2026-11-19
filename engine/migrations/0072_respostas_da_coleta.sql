-- Resposta aceita de cada pergunta, para ver em tabela e exportar CSV (o campo do contato guarda só a última).
ALTER TABLE flow_question_answers ADD COLUMN value TEXT CHECK (value IS NULL OR json_valid(value));
ALTER TABLE flow_question_answers ADD COLUMN answered_at INTEGER;
