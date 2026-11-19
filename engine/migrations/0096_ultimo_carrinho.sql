-- Gatilho de carrinho: o último pedido enviado pelo contato (itens, quantidades e preços) fica no campo de sistema do contato.
ALTER TABLE contacts ADD COLUMN last_cart TEXT CHECK (last_cart IS NULL OR json_valid(last_cart));
