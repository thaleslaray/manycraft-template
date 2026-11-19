-- A IA saiu do produto (respostas por base de conhecimento, passo de IA, comentários, ações ChatGPT/Claude/DeepSeek):
-- as tabelas e as chaves de LLM guardadas somem.
DROP TABLE IF EXISTS ai_comment_replies;
DROP TABLE IF EXISTS ai_session_knowledge;
DROP TABLE IF EXISTS ai_reply_parts;
DROP TABLE IF EXISTS ai_replies;
DROP TABLE IF EXISTS ai_sessions;
DROP TABLE IF EXISTS ai_connections;
DROP TABLE IF EXISTS ai_knowledge;
DROP TABLE IF EXISTS ai_settings;
DROP TABLE IF EXISTS ai_goals;
DROP TABLE IF EXISTS ai_knowledge_entries;
DELETE FROM workspace_integrations WHERE kind IN ('openai','anthropic','deepseek');
