import { test, expect } from './fixtures'
import { api, maisDaLateral, novoTag, q, sql, WORKSPACE } from './helpers'

type Graph = { nodes: { id: string; type: string; config: Record<string, unknown> }[] }

// Jornada: o passo "Iniciar automação" escolhe esperar terminar (padrão) ou seguir sem esperar, e a automação
// chamada mostra "Chamada por" com quem a inicia.
test('iniciar outra automação: escolher esperar ou seguir e ver quem chama', async ({ page }) => {
  test.setTimeout(120_000)
  const tag = novoTag(), alvo = `e2e-alvo-${tag}`, origem = `e2e-origem-${tag}`
  const graphAlvo = { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'message', type: 'message', position: { x: 250, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Mensagem da chamada' }] } }],
  edges: [{ from: 'trigger', port: 'next', to: 'message' }] }
  const graphOrigem = { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'chamar', type: 'start_automation', position: { x: 250, y: 0 }, config: { automation_id: alvo, wait_for_finish: true } },
    { id: 'depois', type: 'message', position: { x: 500, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Voltei ao fluxo original' }] } }],
  edges: [{ from: 'trigger', port: 'next', to: 'chamar' }, { from: 'chamar', port: 'next', to: 'depois' }] }
  sql([
    `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${alvo}','${WORKSPACE}','Alvo da chamada ${tag}','${q(JSON.stringify(graphAlvo))}')`,
    `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${origem}','${WORKSPACE}','Origem da chamada ${tag}','${q(JSON.stringify(graphOrigem))}')`,
    `INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('${alvo}-v1','${WORKSPACE}','${alvo}',1,'${q(JSON.stringify(graphAlvo))}')`,
    `INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('${origem}-v1','${WORKSPACE}','${origem}',1,'${q(JSON.stringify(graphOrigem))}')`,
    `UPDATE automations SET status='live',published_version_id='${alvo}-v1' WHERE id='${alvo}'`,
    `UPDATE automations SET status='live',published_version_id='${origem}-v1' WHERE id='${origem}'`,
  ])
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${origem}`)
    // Automação ao vivo abre na versão publicada: o painel só edita depois de "Editar".
    await page.getByRole('button', { name: 'Editar', exact: true }).first().click()
    await page.locator('.react-flow__node[data-id="chamar"]').click()
    const modo = page.getByRole('combobox', { name: 'Depois de iniciar', exact: true })
    await expect(modo).toContainText('Esperar terminar e voltar')
    await expect(page.getByText('O fluxo fica parado até a outra automação terminar')).toBeVisible()
    await modo.click()
    await page.getByRole('option', { name: 'Seguir sem esperar', exact: true }).click()
    await expect(page.getByText('as duas andam em paralelo')).toBeVisible()
    await expect(page.locator('.react-flow__node[data-id="chamar"]')).toContainText('Segue sem esperar')
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
    await expect(page.getByText('Rascunho salvo', { exact: true })).toBeVisible()
    const detail = await api<{ automation: { draft_graph: Graph } }>(`/api/automations/${origem}`)
    expect(detail.automation.draft_graph.nodes.find(n => n.id === 'chamar')?.config).toMatchObject({ automation_id: alvo, wait_for_finish: false })

    // A automação chamada lista quem a inicia, em desktop e em celular.
    for (const largura of [1440, 390]) {
      await page.setViewportSize({ width: largura, height: 844 })
      await page.goto(`/${WORKSPACE}/automations/${alvo}`)
      await maisDaLateral(page, 'Chamada por')
      const lista = page.getByRole('region', { name: 'Chamada por', exact: true })
      await expect(lista.getByRole('link', { name: /Origem da chamada/ })).toBeVisible()
      await expect(lista).toContainText('Espera esta terminar e volta')
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${alvo}`)
    await maisDaLateral(page, 'Chamada por')
    await page.getByRole('region', { name: 'Chamada por', exact: true }).getByRole('link', { name: /Origem da chamada/ }).click()
    await expect(page).toHaveURL(new RegExp(`/automations/${origem}$`))

    // Quem ninguém chama mostra o estado vazio.
    await page.goto(`/${WORKSPACE}/automations/${origem}`)
    await maisDaLateral(page, 'Chamada por')
    await expect(page.getByRole('region', { name: 'Chamada por', exact: true })).toContainText('Nenhuma automação publicada inicia esta')
  } finally {
    sql([`DELETE FROM automation_versions WHERE automation_id IN ('${alvo}','${origem}')`, `DELETE FROM automations WHERE id IN ('${alvo}','${origem}')`])
  }
})
