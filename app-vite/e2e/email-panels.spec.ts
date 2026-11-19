import { test, expect } from './fixtures'
import { api, consulta, novoTag, q, sql, WORKSPACE, caminhoPrint } from './helpers'

const capture = (name: string) => caminhoPrint(`clone-screens/10b-${name}-${test.info().project.name}.png`)

test('e-mail no perfil original, segmentos de atividade e aviso na conversa persistem', { tag: "@celular" }, async ({ page }) => {
  const suffix = novoTag(), address = `e2e-panel-${suffix}@exemplo.test`, changed = `e2e-edit-${suffix}@exemplo.test`
  let contactId = '', segmentId = ''
  try {
    await page.setViewportSize(test.info().project.name === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 })
    const settings = await api<{defaultSenderId:string}>('/api/email/settings')
    await api('/api/email/settings', {method:'PATCH',body:JSON.stringify({company:{name:'Empresa de estudo',address:'Rua de teste, 123'},paused:false})})
    const sent = await api<{id:string;contactId:string;conversationId:string}>('/api/email/test', {method:'POST',body:JSON.stringify({senderId:settings.defaultSenderId,to:address,subject:`Assunto ${suffix}`,text:'Mensagem para o contato',html:'<p>Mensagem para o contato</p>',consent:true})})
    contactId = sent.contactId
    const outbox = await api<{id:string;html:string}[]>('/api/email/dev/outbox')
    const pixel = outbox.find(row => row.id === sent.id)!.html.match(/src="([^"]*\/api\/email-public\/open\/[^"]+)"/)![1]
    expect((await page.request.get(pixel)).ok()).toBe(true)
    await page.goto(`/${WORKSPACE}/contacts?contact=${contactId}`)
    const profile = page.getByRole('dialog')
    await expect(profile.getByRole('region', {name:'E-mail do contato',exact:true})).toBeVisible()
    await expect(profile.getByText('Abriu e não clicou', {exact:true})).toBeVisible()
    await profile.getByRole('button', {name:`Editar E-mail: ${address}`,exact:true}).click()
    await profile.getByRole('textbox', {name:'E-mail',exact:true}).fill(changed)
    await profile.getByRole('textbox', {name:'E-mail',exact:true}).press('Enter')
    await expect(profile.getByRole('button', {name:`Editar E-mail: ${changed}`,exact:true})).toBeVisible()
    await profile.getByRole('button', {name:'Descadastrar do e-mail',exact:true}).click()
    await expect(profile.getByText('Marketing por e-mail desativado', {exact:true})).toBeVisible()
    await page.reload()
    await expect(profile.getByRole('button', {name:`Editar E-mail: ${changed}`,exact:true})).toBeVisible()
    await expect(profile.getByText('Marketing por e-mail desativado', {exact:true})).toBeVisible()
    await profile.getByRole('region',{name:'E-mail do contato',exact:true}).scrollIntoViewIfNeeded()
    await page.screenshot({path:capture('contacts-profile'),scale:'css'})
    expect(consulta<{opted_in:number;external_user_id:string}>(`SELECT opted_in,external_user_id FROM contact_channels WHERE contact_id='${q(contactId)}'`)).toContainEqual({opted_in:0,external_user_id:changed})
    await page.goto(`/${WORKSPACE}/inbox/${sent.conversationId}`)
    await expect(page.getByText('Marketing por e-mail desativado. Respostas humanas continuam disponíveis.', {exact:true})).toBeVisible()
    await expect(page.getByRole('log',{name:'Histórico da conversa'})).toContainText(`Assunto ${suffix}`)
    await page.getByText('Marketing por e-mail desativado. Respostas humanas continuam disponíveis.', {exact:true}).scrollIntoViewIfNeeded()
    await page.screenshot({path:capture('inbox-warning'),scale:'css'})
    await page.getByLabel('Sua resposta',{exact:true}).fill(`Atendimento ${suffix}`)
    await page.getByRole('button', {name:'Enviar por e-mail',exact:true}).click()
    await expect.poll(async()=>(await api<{text:string}[]>('/api/email/dev/outbox')).some(row=>row.text.includes(`Atendimento ${suffix}`)), {timeout:30000}).toBe(true)
    await page.getByLabel('Sua resposta',{exact:true}).scrollIntoViewIfNeeded()
    await page.screenshot({path:capture('inbox'),scale:'css'})
    await page.goto(`/${WORKSPACE}/contacts`)
    await page.getByRole('button',{name:'Filtrar contatos',exact:true}).click()
    await page.getByRole('button',{name:'+ Condição',exact:true}).click()
    await page.getByRole('combobox',{name:'Filtrar por atividade de e-mail',exact:true}).click()
    await page.getByRole('option',{name:'Marketing por e-mail desativado',exact:true}).click()
    await page.getByRole('combobox',{name:'Filtrar por campo de e-mail',exact:true}).click()
    await page.getByRole('option',{name:'Total de aberturas: no mínimo',exact:true}).click()
    await page.getByLabel('Quantidade mínima',{exact:true}).fill('1')
    await expect(page.getByRole('button', {name:`e2e-panel-${suffix}`,exact:true})).toBeVisible()
    await page.getByRole('combobox',{name:'Filtrar por campo de e-mail',exact:true}).click()
    await page.getByRole('option',{name:'Última abertura: nos últimos dias',exact:true}).click()
    await page.getByLabel('Quantidade de dias',{exact:true}).fill('7')
    await expect(page.getByRole('button',{name:'Salvar como segmento',exact:true})).toBeEnabled()
    await page.getByRole('button',{name:'Salvar como segmento',exact:true}).click()
    const segment = page.getByRole('dialog',{name:'Salvar segmento de e-mail'})
    await segment.getByLabel('Nome do segmento',{exact:true}).fill(`Sem marketing ${suffix}`)
    await segment.getByRole('button',{name:'Salvar segmento',exact:true}).click()
    await expect(segment).toHaveCount(0)
    const segments = await api<{id:string;name:string}[]>('/api/email/segments')
    segmentId = segments.find(row=>row.name===`Sem marketing ${suffix}`)!.id
    await page.reload()
    await page.getByRole('button',{name:'Filtrar contatos',exact:true}).click()
    await page.getByRole('button',{name:'+ Condição',exact:true}).click()
    await page.getByRole('combobox',{name:'Filtrar por segmento',exact:true}).click()
    await page.getByRole('option',{name:`Sem marketing ${suffix}`,exact:true}).click()
    await expect(page.getByRole('button', {name:`e2e-panel-${suffix}`,exact:true})).toBeVisible()
    await expect.poll(async()=>(await api<{rows:{id:string}[]}>(`/api/contacts?segment_id=${segmentId}`)).rows.some(row=>row.id===contactId)).toBe(true)
    await page.screenshot({path:capture('contacts-filter'),scale:'css'})
  } finally {
    sql([`DELETE FROM contacts WHERE workspace_id='${WORKSPACE}' AND id='${q(contactId)}'`, ...(segmentId ? [`DELETE FROM segments WHERE workspace_id='${WORKSPACE}' AND id='${q(segmentId)}'`] : [])])
  }
})

test('perfil original define e-mail sem autorizar marketing nem mudar a inscrição de outra conexão', async ({page}) => {
  const { canalE2eSql, contatoSql } = await import('./helpers')
  const suffix = novoTag(), id = `e2e-email-capture-${suffix}`, channel = `e2e-panel-channel-${suffix}`, capability = `e2e-panel-mail-${suffix}`
  const address = `e2e-capture-${suffix}@exemplo.test`
  sql([...canalE2eSql(channel), ...canalE2eSql(capability, "email"), ...contatoSql({id,canal:channel,nome:'Pessoa',sobrenome:`Cadastro${suffix}`})])
  try {
    await api('/api/email/settings')
    await page.goto(`/${WORKSPACE}/contacts?contact=${id}`)
    const profile = page.getByRole('dialog')
    await profile.getByRole('button',{name:'Editar E-mail: vazio',exact:true}).click()
    await profile.getByRole('textbox',{name:'E-mail',exact:true}).fill(address)
    await profile.getByRole('textbox',{name:'E-mail',exact:true}).press('Enter')
    await expect(profile.getByRole('button',{name:`Editar E-mail: ${address}`,exact:true})).toBeVisible()
    await page.reload()
    await expect(profile.getByRole('button',{name:`Editar E-mail: ${address}`,exact:true})).toBeVisible()
    const identities = consulta<{channel_id:string;external_user_id:string;opted_in:number}>(`SELECT channel_id,external_user_id,opted_in FROM contact_channels WHERE contact_id='${id}'`)
    expect(identities).toHaveLength(2)
    expect(identities).toContainEqual({channel_id:channel,external_user_id:`${id}-ext`,opted_in:1})
    expect(identities.find(row=>row.external_user_id===address)?.opted_in).toBe(0)
  } finally {
    sql([`DELETE FROM contacts WHERE workspace_id='${WORKSPACE}' AND id='${id}'`, `DELETE FROM channels WHERE workspace_id='${WORKSPACE}' AND id IN ('${channel}','${capability}')`])
  }
})
