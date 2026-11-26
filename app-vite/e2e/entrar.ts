import { expect, type BrowserContext, type Page } from "@playwright/test"
import { PAINEL, consulta, q } from "./helpers"

// Entrada por código de 6 dígitos SEM passar pela tela de login: para as jornadas que precisam de uma sessão real
// (outra conta, convidado, dono de um espaço novo) e não estão testando a própria tela. Quem testa a tela é auth.spec.ts.
//
// De onde vem o código: da tabela `email_outbox` do D1 local, onde o motor grava todo e-mail no desenvolvimento
// (tipo `login_code`). A linha `[auth] código de login para <email>: <código>` do terminal do motor tem o mesmo
// código, mas o arquivo onde ela cai depende de como o servidor subiu (`.dev-logs/engine.log` no dev:local,
// `.dev-logs/e2e-amb-<i>/motor.log` nos ambientes paralelos, só o terminal quando sobe à mão), enquanto o outbox
// segue o banco da jornada (`E2E_STATE_PATH`), é lido pelo mesmo `consulta` que as jornadas já usam para os e-mails
// e filtra por destinatário e horário. O motor grava no outbox antes de imprimir a linha.

type Contexto = BrowserContext | Page

const CODIGO = /\b(\d{6})\b/

/** Último código de login enviado a `email` a partir de `desde` (ms), esperando o e-mail chegar ao outbox. */
export async function codigoDoEmail(email: string, desde: number, esperaMs = 15_000): Promise<string> {
  const limite = Date.now() + esperaMs
  // Folga de 1 s: o relógio do motor e o da jornada são o mesmo, mas o `created_at` é gravado depois do pedido sair.
  const sqlCodigo = `SELECT subject,text FROM email_outbox WHERE lower(recipient)=lower('${q(email)}') AND kind='login_code' AND created_at>=${desde - 1000} ORDER BY created_at DESC LIMIT 1`
  for (;;) {
    const linha = consulta<{ subject: string; text: string }>(sqlCodigo)[0]
    const codigo = linha && (linha.subject.match(CODIGO)?.[1] ?? linha.text.match(CODIGO)?.[1])
    if (codigo) return codigo
    if (Date.now() > limite) throw new Error(`O código de login para ${email} não chegou ao outbox local (email_outbox, tipo login_code).`)
    await new Promise(r => setTimeout(r, 300))
  }
}

/**
 * Entra como `email` pelo código, pela API (sem a tela), deixando a sessão nos cookies do contexto do navegador.
 * Serve para conta existente e para e-mail convidado ou novo (o primeiro código cria a conta, com o e-mail confirmado
 * e `name` vazio; `nome` grava o nome pela API do Better Auth, como faria a própria pessoa).
 * Não navega: a jornada abre a página que quiser em seguida.
 */
export async function entrarPorCodigo(alvo: Contexto, email: string, opcoes: { nome?: string } = {}): Promise<void> {
  const request = alvo.request
  const headers = { origin: PAINEL }
  const desde = Date.now()
  const pedido = await request.post(`${PAINEL}/api/auth/email-otp/send-verification-otp`, { headers, data: { email, type: "sign-in" } })
  expect(pedido.ok(), `pedido do código para ${email}: ${pedido.status()} ${await pedido.text()}`).toBe(true)
  const otp = await codigoDoEmail(email, desde)
  const entrada = await request.post(`${PAINEL}/api/auth/sign-in/email-otp`, { headers, data: { email, otp } })
  expect(entrada.ok(), `entrada com o código para ${email}: ${entrada.status()} ${await entrada.text()}`).toBe(true)
  if (opcoes.nome !== undefined) {
    const nome = await request.post(`${PAINEL}/api/auth/update-user`, { headers, data: { name: opcoes.nome } })
    expect(nome.ok(), `nome de ${email}: ${nome.status()} ${await nome.text()}`).toBe(true)
  }
  const sessao = await (await request.get(`${PAINEL}/api/auth/get-session`)).json() as { user?: { email?: string } } | null
  expect(sessao?.user?.email?.toLowerCase(), "a sessão aberta pelo código é da conta pedida").toBe(email.toLowerCase())
}
