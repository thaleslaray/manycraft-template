-- Botão de link com saída: o token guarda o endereço congelado para o redirecionamento rastreado.
ALTER TABLE button_tokens ADD COLUMN target_url TEXT;
