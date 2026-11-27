# Histórico de versões

O que mudou em cada versão do ManyCraft, da mais nova para a mais antiga.

Como atualizar: se você não mexeu no código, baixe a versão nova por cima. Se personalizou, compare antes, porque pode haver conflito.

## 0.1.6 (27/11/2026)

Só documentação.

- README: o roteiro de publicação do conector do Claude foi refeito depois de um teste do zero. Agora mostra como pôr o painel em domínio próprio, a ordem dos passos, a publicação do painel depois do build e como conferir.

## 0.1.5 (26/11/2026)

Só documentação.

- README: seção nova "API" (onde fica a documentação, como criar e usar a chave, o que a chave não faz).
- README: a seção do conector do Claude explica como ele funciona, as travas e os limites.
- README: o envio de e-mail agora se liga com um comando (`npx wrangler email sending enable`), e pode ser num subdomínio.
- README: o roteiro do código de login foi testado de ponta a ponta numa publicação nova (plano pago).
- Este arquivo de histórico.

## 0.1.4 (26/11/2026)

Só documentação.

- README: aviso de que o uso real pede o plano pago da Cloudflare (Workers Paid), com o que não funciona no gratuito.

## 0.1.3 (26/11/2026)

- Licença de uso (arquivo `LICENSE`): pode usar e atender clientes cobrando pelo serviço; não pode vender nem redistribuir o código.

## 0.1.2 (26/11/2026)

- **Login novo, sem senha:** entra-se com um código de 6 dígitos enviado ao e-mail, ou pelo Google. Saíram as telas de cadastro, de senha e de link por e-mail. Quem já tinha conta entra por código com o mesmo e-mail.
- **Conector do Claude (opcional):** pasta nova `mcp/`, um servidor MCP em um terceiro Worker que deixa o Claude ler e operar o ManyCraft pela API. Conecta por login, sem colar chave; ações sem volta vêm bloqueadas; cada execução tem teto de 50 pedidos e 30 segundos.
- **API:** a chave de perfil vale com ou sem o começo `perfil:`; a documentação ganhou o filtro por conta conectada e o formato das respostas mais usadas.
- Filtro por conta conectada em Contatos e na Caixa de entrada.
- Transmissões: seletor de conexão com o ícone e o nome do canal.
- Caixa de entrada: sessão vencida leva ao login, em vez de tentar reconectar sem parar.
- Menus Aplicativos, Modelos instalados e Integrações (Google Sheets, Hotmart, Pixel) ocultos no painel.

Atenção ao atualizar da 0.1.1: o sistema publicado passa a exigir envio de e-mail configurado (ou o Google) para alguém entrar.

## 0.1.1 (19/11/2026)

Só documentação.

- README: roteiro de publicação na Cloudflare refeito depois de um teste do zero (ordem dos passos, filas criadas à mão, conferência final).

## 0.1.0 (19/11/2026)

- Primeira versão.
