-- Saíram do produto: compartilhamento protegido (a cópia chegava travada), status "visitante" e catálogo de produtos com link de pagamento.
-- Quem era visitante vira contato inscrito normal (a restrição do status continua aceitando o valor antigo, que ninguém mais grava).
ALTER TABLE automation_shares DROP COLUMN protected;
UPDATE contacts SET status = 'subscribed' WHERE status = 'visitor';
DROP TABLE products;
