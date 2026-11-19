import { test, expect } from './fixtures'
import { consulta, novoTag, q, sql, WORKSPACE } from './helpers'

const gravado = () => consulta<{ n: number }>(`SELECT (SELECT count(*) FROM flow_runs) + (SELECT count(*) FROM contacts) + (SELECT count(*) FROM contact_tags) + (SELECT count(*) FROM messages) + (SELECT count(*) FROM node_events) AS n`)[0].n

// Fluxo com texto, botão, pergunta, ação com etiqueta e espera; a prévia não pode gravar nada.
const grafo = { nodes: [
  { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
  { id: 'oferta', type: 'message', position: { x: 360, y: 0 }, config: { blocks: [
    { kind: 'text', text: 'Olá {{primeiro_nome|amigo}}, quer saber mais?' },
    { kind: 'button', id: 'sim', label: 'Quero saber', action: { type: 'go_to_node' } },
  ] } },
  { id: 'pergunta', type: 'question', position: { x: 720, y: 0 }, config: { text: 'Qual é o seu e-mail?', answer_type: 'email', field_id: 'system:email', retry_message: 'Esse e-mail não parece certo.', max_attempts: 3, skip: false, timeout: { value: 5, unit: 'minutes' }, choices: [] } },
  { id: 'espera', type: 'smart_delay', position: { x: 1080, y: 0 }, config: { duration: { value: 2, unit: 'days' } } },
  { id: 'fim', type: 'message', position: { x: 1440, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Anotado, obrigado!' }] } },
], edges: [
  { from: 'trigger', port: 'next', to: 'oferta' },
  { from: 'oferta', port: 'btn:sim', to: 'pergunta' },
  { from: 'pergunta', port: 'success', to: 'espera' },
  { from: 'espera', port: 'next', to: 'fim' },
] }

test('prévia percorre botão, pergunta e espera sem gravar nada', { tag: "@celular" }, async ({ page }, info) => {
  const automation = `e2e-previa-${novoTag()}`
  sql([`INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${automation}','${WORKSPACE}','Prévia de teste','${q(JSON.stringify(grafo))}')`])
  try {
    const antes = gravado()
    await page.goto(`/${WORKSPACE}/automations/${automation}`)
    if (info.project.name === 'mobile') await expect(page.getByRole('heading', { level: 1, name: 'Prévia de teste' })).toBeVisible()
    const botao = page.getByRole('button', { name: 'Prévia' })
    await botao.click()
    const painel = page.getByRole('region', { name: 'Prévia da automação' })
    await expect(painel).toBeVisible()
    await expect(painel).toContainText('nada é enviado, gravado nem chamado')
    await expect(painel.getByRole('log')).toContainText('Olá Maria, quer saber mais?')

    await painel.getByRole('button', { name: 'Quero saber' }).click()
    await expect(painel.getByRole('log')).toContainText('Qual é o seu e-mail?')

    const resposta = painel.getByRole('textbox', { name: 'Resposta do contato' })
    await expect(resposta).toBeFocused()
    await resposta.fill('isso não é e-mail')
    await resposta.press('Enter')
    await expect(painel.getByRole('log')).toContainText('Esse e-mail não parece certo.')
    await expect(resposta).toBeFocused()
    await resposta.fill('ana@exemplo.com')
    await resposta.press('Enter')

    const conversa = painel.getByRole('log')
    await expect(conversa).toContainText('Espera de 2 dias pulada na prévia')
    await expect(conversa).toContainText('Anotado, obrigado!')
    await expect(painel.getByRole('status')).toContainText('O fluxo termina aqui')

    // Nada foi gravado: nem execução, contato, etiqueta, mensagem nem métrica.
    expect(gravado()).toBe(antes)

    await painel.getByRole('button', { name: 'Recomeçar' }).first().click()
    await expect(painel.getByRole('log')).not.toContainText('Anotado, obrigado!')
    await expect(painel.getByRole('button', { name: 'Quero saber' })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(painel).toBeHidden()
    // A página não rola de lado (390px e 1440px).
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  } finally {
    sql([`DELETE FROM automations WHERE id='${automation}'`])
  }
})
