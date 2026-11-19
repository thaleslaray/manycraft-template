import { test, expect } from './fixtures'
import { WORKSPACE, acaoDoTopo, adicionarCondicao, canalE2eSql, consulta, novoTag, q, sql } from './helpers'

test('transmissões: excluir com confirmação, agendada pausada fica em Agendado, atrasada avisa e a cópia nasce da própria transmissão', { tag: "@celular" }, async ({ page, erros }, info) => {
  const desktop = info.project.name === 'desktop'
  await page.setViewportSize(desktop ? { width: 1440, height: 900 } : { width: 390, height: 844 })
  const t = novoTag(), canal = `e2e-bg-${t}`, prefixo = `Gerir ${t}`
  const agora = Date.now(), dia = 86_400_000
  const linhas = [
    { id: `e2e-bg-${t}-rascunho`, nome: `${prefixo} rascunho`, status: 'draft', em: null, pausa: null },
    { id: `e2e-bg-${t}-futura`, nome: `${prefixo} futura`, status: 'scheduled', em: agora + 3 * dia, pausa: null },
    { id: `e2e-bg-${t}-pausada`, nome: `${prefixo} pausada`, status: 'scheduled', em: agora + 5 * dia, pausa: agora },
    { id: `e2e-bg-${t}-atrasada`, nome: `${prefixo} atrasada`, status: 'scheduled', em: agora - 6 * 3_600_000, pausa: null },
    { id: `e2e-bg-${t}-enviada`, nome: `${prefixo} enviada`, status: 'sent', em: agora - dia, pausa: null },
  ]
  sql([
    ...canalE2eSql(canal),
    `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('e2e-bg-${t}-vazia','${WORKSPACE}','${prefixo} sem mensagem','{"nodes":[],"edges":[]}')`,
    `INSERT INTO contacts(id,workspace_id,first_name,last_name) VALUES ('e2e-bg-${t}-c','${WORKSPACE}','Marina','Gerir ${t}')`,
    `INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('e2e-bg-${t}-cc','${WORKSPACE}','e2e-bg-${t}-c','${canal}','770${Math.floor(Math.random() * 90000) + 10000}',1)`,
    ...linhas.map(l => `INSERT INTO broadcasts(id,workspace_id,name,channel_id,audience_filter,status,scheduled_at,scheduled_local,paused_at,pause_reason,started_at,content,timezone,updated_at) VALUES ('${l.id}','${WORKSPACE}','${q(l.nome)}','${canal}','{"tag":"all"}','${l.status}',${l.em ?? 'NULL'},'${l.em ? new Date(l.em - 3 * 3_600_000).toISOString().slice(0, 16) : ''}',${l.pausa ?? 'NULL'},${l.pausa ? "'manual'" : 'NULL'},${l.status === 'sent' ? l.em : 'NULL'},'Olá, equipe','America/Sao_Paulo',${l.em ?? agora})`),
    `INSERT INTO broadcast_recipients(workspace_id,broadcast_id,contact_channel_id,status,run_id,sent_at,updated_at) VALUES ('${WORKSPACE}','e2e-bg-${t}-enviada','e2e-bg-${t}-cc','sent','run-bg-${t}',${agora},${agora})`,
  ])
  try {
    // "A partir de automação": quando a cópia não é possível, o motivo aparece no pop-up e ele continua aberto.
    await page.goto(`/${WORKSPACE}/broadcasts`)
    await acaoDoTopo(page, 'Transmissão a partir de uma automação')
    const escolha = page.getByRole('dialog', { name: 'Transmissão a partir de automação' })
    await escolha.getByRole('combobox', { name: 'Buscar automação' }).fill(`${prefixo} sem mensagem`)
    await escolha.getByRole('option', { name: `${prefixo} sem mensagem` }).click()
    await escolha.getByRole('button', { name: 'Usar esta automação' }).click()
    await expect(escolha.getByRole('alert')).toContainText('mensagem inicial')
    await expect(escolha).toBeVisible()
    erros.splice(0) // o 409 esperado aparece no console como falha de carregamento
    await escolha.getByRole('button', { name: 'Cancelar' }).click()
    await page.goto(`/${WORKSPACE}/broadcasts?lista=agendado`)
    await page.getByRole('searchbox', { name: 'Buscar transmissão pelo nome' }).fill(prefixo)
    const agendado = page.getByRole('region', { name: 'Agendado', exact: true })
    // Pausada continua em Agendado com o selo; vencida sem envio mostra "Atrasado"; nenhuma delas cai no Histórico.
    await expect(agendado.getByRole('row').filter({ hasText: `${prefixo} pausada` })).toContainText('Pausado')
    await expect(agendado.getByRole('row').filter({ hasText: `${prefixo} atrasada` })).toContainText('Atrasado')
    await expect(agendado.getByRole('row').filter({ hasText: `${prefixo} futura` })).not.toContainText(/Pausado|Atrasado/)
    // A pausada abre para edição (não cai no aviso de "já enviada").
    await agendado.getByRole('button', { name: `Editar ${prefixo} pausada`, exact: true }).click()
    await expect(page.getByLabel('Nome da transmissão')).toHaveValue(`${prefixo} pausada`)
    await page.goto(`/${WORKSPACE}/broadcasts?lista=historico`)
    await page.getByRole('searchbox', { name: 'Buscar transmissão pelo nome' }).fill(prefixo)
    const historico = page.getByRole('region', { name: 'Histórico', exact: true })
    await expect(historico.getByRole('row').filter({ hasText: prefixo })).toHaveCount(1)
    await historico.getByRole('button', { name: `Mais ações de ${prefixo} enviada`, exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Excluir' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    // Excluir pede confirmação: cancelar mantém, confirmar apaga.
    await page.goto(`/${WORKSPACE}/broadcasts?lista=rascunhos`)
    await page.getByRole('searchbox', { name: 'Buscar transmissão pelo nome' }).fill(prefixo)
    const rascunhos = page.getByRole('region', { name: 'Rascunhos', exact: true })
    // A condição "Grupo de inscritos" aberta no valor padrão continua lá depois de salvar e reabrir.
    await rascunhos.getByRole('button', { name: `Editar ${prefixo} rascunho`, exact: true }).click()
    await adicionarCondicao(page, 'Grupo de inscritos')
    await acaoDoTopo(page, 'Salvar rascunho')
    await expect(page).toHaveURL(/\/broadcasts$/)
    await page.goto(`/${WORKSPACE}/broadcasts/e2e-bg-${t}-rascunho`)
    await expect(page.getByLabel('Grupo de inscritos', { exact: true })).toBeVisible()
    await page.goto(`/${WORKSPACE}/broadcasts?lista=rascunhos`)
    await page.getByRole('searchbox', { name: 'Buscar transmissão pelo nome' }).fill(prefixo)
    await rascunhos.getByRole('button', { name: `Mais ações de ${prefixo} rascunho`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Excluir' }).click()
    const confirmacao = page.getByRole('dialog', { name: 'Excluir transmissão?' })
    await confirmacao.getByRole('button', { name: 'Cancelar' }).click()
    await expect(rascunhos.getByRole('row').filter({ hasText: `${prefixo} rascunho` })).toHaveCount(1)
    await rascunhos.getByRole('button', { name: `Mais ações de ${prefixo} rascunho`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Excluir' }).click()
    await page.getByRole('dialog', { name: 'Excluir transmissão?' }).getByRole('button', { name: 'Excluir' }).click()
    await expect(page.getByText('Transmissão excluída.')).toBeVisible()
    await expect(rascunhos.getByRole('row').filter({ hasText: `${prefixo} rascunho` })).toHaveCount(0)
    expect(consulta(`SELECT id FROM broadcasts WHERE id='e2e-bg-${t}-rascunho'`)).toEqual([])

    // Agendada também se exclui; a enviada não tem a opção.
    await page.goto(`/${WORKSPACE}/broadcasts?lista=agendado`)
    await page.getByRole('searchbox', { name: 'Buscar transmissão pelo nome' }).fill(prefixo)
    await agendado.getByRole('button', { name: `Mais ações de ${prefixo} futura`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Excluir' }).click()
    await page.getByRole('dialog', { name: 'Excluir transmissão?' }).getByRole('button', { name: 'Excluir' }).click()
    await expect(agendado.getByRole('row').filter({ hasText: `${prefixo} futura` })).toHaveCount(0)

    // Relatório: destinatários pelo nome do contato e "Copiar e editar" da própria transmissão.
    await page.goto(`/${WORKSPACE}/broadcasts/e2e-bg-${t}-enviada/report`)
    await page.getByRole('button', { name: 'Mais ações', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Consultar destinatários', exact: true }).click()
    const lista = page.getByRole('dialog').getByRole('list', { name: 'Destinatários' })
    await expect(lista).toContainText(`Marina Gerir ${t}`)
    await expect(lista).not.toContainText('e2e-bg-')
    await page.keyboard.press('Escape')
    if (desktop) await page.getByRole('button', { name: 'Copiar e editar' }).first().click()
    else { await page.getByRole('button', { name: 'Mais ações', exact: true }).click(); await page.getByRole('menuitem', { name: 'Copiar e editar' }).click() }
    await expect(page).toHaveURL(/\/broadcasts\/(?!.*report)[^/]+$/)
    await expect(page.getByLabel('Nome da transmissão')).toHaveValue(`Cópia de ${prefixo} enviada`)
    expect(consulta<{ status: string }>(`SELECT status FROM broadcasts WHERE name='${q(`Cópia de ${prefixo} enviada`)}'`)).toEqual([{ status: 'draft' }])
  } finally {
    sql([`DELETE FROM broadcasts WHERE workspace_id='${WORKSPACE}' AND (id LIKE 'e2e-bg-${t}-%' OR name LIKE '%${prefixo}%')`, `DELETE FROM contacts WHERE id='e2e-bg-${t}-c'`, `DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND (id='e2e-bg-${t}-vazia' OR id LIKE 'broadcast-%' AND name LIKE '%${prefixo}%')`, `DELETE FROM channels WHERE id='${canal}'`])
  }
})
