import { test, expect } from './fixtures'
import { api, consulta, novoTag, q, sql, WORKSPACE, caminhoPrint } from './helpers'
const capture = (name:string) => caminhoPrint(`clone-screens/10-email-${name}-${test.info().project.name}.png`)

test.describe('Canal de e-mail', () => {
  test.beforeEach(async ({page}) => {
    await page.setViewportSize(test.info().project.name === 'desktop' ? {width:1440,height:900} : {width:390,height:844})
  })
  test('configuração de remetente persiste depois de recarregar', { tag: "@celular" }, async ({ page }) => {
    const settings = await api<{ senders: { id: string; name: string; address: string }[] }>('/api/email/settings')
    expect(settings.senders.length).toBeGreaterThan(0)
    await page.goto(`/${WORKSPACE}/settings/email`)
    await expect(page.getByRole('heading', { name: 'E-mail', exact: true })).toBeVisible()
    await expect(page.getByText(settings.senders[0].address, { exact: true }).first()).toBeVisible()
    const name = `Equipe ${novoTag()}`
    await page.getByRole('button', { name: 'Editar', exact: true }).first().click()
    await page.getByLabel('Nome do remetente', { exact: true }).fill(name)
    await page.getByRole('button', { name: 'Salvar remetente' }).click()
    await expect(page.getByRole('dialog', { name: 'Editar remetente' })).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    await expect(page.getByText(settings.senders[0].address, { exact: true }).first()).toBeVisible()
    await page.screenshot({path:capture('settings'),scale:'css'})
    await api(`/api/email/senders/${settings.senders[0].id}`, {method:'PATCH',body:JSON.stringify({name:settings.senders[0].name})})
  })

  test('domínio próprio exige confirmação antes do DNS e aceite do aquecimento', { tag: "@celular" }, async ({page})=>{
    const tag=novoTag(), address=`equipe@empresa-${tag}.test`
    try {
      await page.goto(`/${WORKSPACE}/settings/email`)
      await page.getByRole('button',{name:'Novo endereço',exact:true}).click()
      const form=page.getByRole('dialog',{name:'Novo endereço de envio'})
      await form.getByLabel('Endereço de e-mail',{exact:true}).fill(address)
      await form.getByLabel('Nome do remetente',{exact:true}).fill(`Empresa ${tag}`)
      await form.getByRole('button',{name:'Salvar remetente'}).click()
      const row=page.locator('div.grid').filter({has:page.getByText(address,{exact:true})}).first()
      await row.getByRole('button',{name:'Configurar domínio'}).click()
      const guide=page.getByRole('dialog',{name:`Autenticar empresa-${tag}.test`})
      await expect(guide.getByRole('button',{name:'Verificar registros (simulado)'})).toBeDisabled()
      await guide.getByRole('button',{name:'Confirmar endereço (simulado)'}).click()
      await expect(guide.getByText('_email-verification',{exact:true})).toBeVisible()
      await guide.getByRole('checkbox',{name:'Entendi que preciso aquecer a reputação do domínio.'}).check()
      await page.screenshot({path:capture('domain'),scale:'css'})
      await guide.getByRole('button',{name:'Verificar registros (simulado)'}).click()
      await expect.poll(async()=> (await api<{senders:{address:string;status:string}[]}>('/api/email/settings')).senders.find(row=>row.address===address)?.status).toBe('verified')
    } finally {
      sql([`DELETE FROM email_senders WHERE workspace_id='${WORKSPACE}' AND address='${q(address)}'`])
    }
  })

  test('e-mail falso recebe resposta uma vez no Inbox e permite resposta humana após descadastro', { tag: "@celular" }, async ({ page }) => {
    const tag = novoTag(), to = `e2e-${tag}@exemplo.test`, subject = `Pedido ${tag}`
    const settings = await api<{defaultSenderId: string}>('/api/email/settings')
    await api('/api/email/settings', { method: 'PATCH', body: JSON.stringify({ company: { name: 'Empresa de estudo', address: 'Rua de teste, 123' }, paused: false }) })
    let conversationId: string | undefined
    try {
      const sent = await api<{ id: string; messageId: string; conversationId: string }>('/api/email/test', { method: 'POST', body: JSON.stringify({ senderId: settings.defaultSenderId, to, subject, preheader: 'Acompanhe seu pedido', text: 'Olá, seu pedido está pronto.', html: '<p>Seu pedido está pronto.</p><a href="https://exemplo.test/pedido">Ver pedido</a>', consent: true }) })
      conversationId = sent.conversationId
      const outbox = await api<{id: string; replyTo: string; html: string}[]>('/api/email/dev/outbox')
      const out = outbox.find(row => row.id === sent.id)!
      expect(out.html).toContain('/api/email-public/unsubscribe/')
      expect(out.html).toContain('/api/email-public/open/')
      expect(out.html).toContain('/api/email-public/click/')
      const inbound = { from: to, to: out.replyTo, messageId: `<e2e-${tag}@exemplo.test>`, inReplyTo: sent.messageId, text: 'STOP' }
      expect(await api('/api/email/dev/inbound', {method:'POST',body:JSON.stringify(inbound)})).toMatchObject({accepted:true})
      expect(await api('/api/email/dev/inbound', {method:'POST',body:JSON.stringify(inbound)})).toMatchObject({accepted:true,duplicate:true})
      expect(consulta<{n:number}>(`SELECT count(*) n FROM messages WHERE external_message_id='email:email-channel-${WORKSPACE}:${q(to)}:${q(inbound.messageId)}'`)[0].n).toBe(1)
      await page.goto(`/${WORKSPACE}/inbox/${conversationId}`)
      await expect(page.getByRole('log', {name:'Histórico da conversa'}).getByText('STOP', {exact:true})).toBeVisible()
      const composer = page.getByLabel('Sua resposta', {exact:true})
      await composer.fill(`Resposta de conversa ${tag}`)
      await page.getByRole('button', {name:'Enviar por e-mail',exact:true}).click()
      await expect.poll(async () => (await api<{text:string}[]>('/api/email/dev/outbox')).some(row => row.text.includes(`Resposta de conversa ${tag}`))).toBe(true)
      expect(consulta<{opted_in:number}>(`SELECT opted_in FROM contact_channels WHERE workspace_id='${WORKSPACE}' AND external_user_id='${q(to)}'`)[0].opted_in).toBe(0)
      await page.reload()
      await expect(page.getByRole('log', {name:'Histórico da conversa'}).getByText(`Resposta de conversa ${tag}`, {exact:true})).toBeVisible()
      await page.screenshot({path:capture('inbox'),scale:'css'})
      const unsubscribe=out.html.match(/href="([^"]*\/api\/email-public\/unsubscribe\/[^\"]+)"/)![1]
      await page.goto(unsubscribe)
      await expect(page.getByRole('heading',{name:'Descadastro confirmado',exact:true})).toBeVisible()
      await page.screenshot({path:capture('unsubscribe'),scale:'css'})
    } finally {
      const contact = `SELECT contact_id FROM contact_channels WHERE workspace_id='${WORKSPACE}' AND external_user_id='${q(to)}'`
      sql([`DELETE FROM contacts WHERE workspace_id='${WORKSPACE}' AND id IN (${contact})`, `DELETE FROM email_receipts WHERE workspace_id='${WORKSPACE}' AND message_id='<e2e-${tag}@exemplo.test>'`])
    }
  })

  test('Easy Email compila HTML no navegador, salva rascunho e envia teste falso pela tela', { tag: "@celular" }, async ({ page }) => {
    const tag = novoTag(), to = `e2e-design-${tag}@exemplo.test`, name = `Rascunho ${tag}`, subject = `Seu pedido ${tag}`
    await api('/api/email/settings', {method:'PATCH',body:JSON.stringify({company:{name:'Empresa de estudo',address:'Rua de teste, 123'},paused:false})})
    try {
      await page.goto(`/${WORKSPACE}/settings/email/design`)
      await page.getByLabel('Nome do rascunho', {exact:true}).fill(name)
      await page.getByLabel('Assunto', {exact:true}).fill(subject)
      await page.getByLabel('Prévia', {exact:true}).fill('Veja os detalhes do pedido')
      await expect(page.getByText('Preparando editor…', {exact:true})).toHaveCount(0, {timeout:30000})
      await page.getByRole('button', {name:'Salvar rascunho',exact:true}).click()
      await expect(page.getByText('Rascunho salvo no espaço de trabalho.', {exact:true})).toBeVisible()
      const drafts = await api<{id:string;name:string;html:string;subject:string}[]>('/api/email/drafts')
      const draft = drafts.find(row => row.name === name)!
      expect(draft.html).toContain('<html')
      expect(draft.subject).toBe(subject)
      await page.screenshot({path:capture('design'),scale:'css'})
      await page.getByRole('heading',{name:'Design da mensagem',exact:true}).scrollIntoViewIfNeeded()
      await page.screenshot({path:capture('editor'),scale:'css'})
      await page.reload()
      await page.getByRole('link', {name,exact:true}).click()
      await expect(page.getByLabel('Assunto', {exact:true})).toHaveValue(subject)
      await page.getByLabel('Destinatário de teste', {exact:true}).fill(to)
      await page.getByRole('checkbox', {name:'Confirmo que o teste usa apenas o transporte simulado local.'}).check()
      await page.getByRole('button', {name:'Enviar teste',exact:true}).click()
      await expect(page.getByRole('status').filter({hasText:`Teste simulado registrado para ${to}.`})).toBeVisible()
      expect((await api<{to:string;subject:string}[]>('/api/email/dev/outbox')).some(row=>row.to===to&&row.subject===subject)).toBe(true)
    } finally {
      sql([`DELETE FROM contacts WHERE workspace_id='${WORKSPACE}' AND id IN (SELECT contact_id FROM contact_channels WHERE workspace_id='${WORKSPACE}' AND external_user_id='${q(to)}')`, `DELETE FROM email_drafts WHERE workspace_id='${WORKSPACE}' AND json_extract(content,'$.name')='${q(name)}'`])
    }
  })

  test('resposta falsa dispara automação publicada com HTML congelado e segue para o próximo passo', async () => {
    const tag=novoTag(), to=`e2e-flow-${tag}@exemplo.test`, id=`e2e-email-flow-${tag}`, keyword=`pedido-${tag}`
    const graph={nodes:[{id:'t',type:'trigger',position:{x:0,y:0},config:{}},{id:'mail',type:'message',position:{x:250,y:0},config:{blocks:[{kind:'text',text:'Versão inicial'}]}},{id:'next',type:'message',position:{x:500,y:0},config:{blocks:[{kind:'text',text:`Próximo passo ${tag}`}]}}],edges:[{from:'t',port:'next',to:'mail'},{from:'mail',port:'next',to:'next'}]}
    const settings=await api<{defaultSenderId:string}>('/api/email/settings')
    await api('/api/email/settings',{method:'PATCH',body:JSON.stringify({company:{name:'Empresa de estudo',address:'Rua de teste, 123'},paused:false})})
    let draftId:string|undefined
    try {
      const first=await api<{id:string;messageId:string}>('/api/email/test',{method:'POST',body:JSON.stringify({senderId:settings.defaultSenderId,to,subject:'Abra uma conversa',preheader:'Pode responder',text:'Responda para continuar',consent:true})})
      const initial=(await api<{id:string;replyTo:string}[]>('/api/email/dev/outbox')).find(row=>row.id===first.id)!
      const channel=consulta<{channel_id:string}>(`SELECT channel_id FROM contact_channels WHERE workspace_id='${WORKSPACE}' AND external_user_id='${q(to)}'`)[0].channel_id
      sql([`INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${id}','${WORKSPACE}','E-mail de teste ${tag}','${q(JSON.stringify(graph))}')`, `INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES ('${id}-trg','${WORKSPACE}','${id}','${q(channel)}','Pedido','keyword','active','every_time','{"node_id":"t"}')`, `INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('${id}-kw','${WORKSPACE}','${id}-trg','is','["${keyword}"]','live',0)`])
      const draft=await api<{id:string}>('/api/email/drafts',{method:'POST',body:JSON.stringify({name:id,senderId:settings.defaultSenderId,subject:`Assunto congelado ${tag}`,preheader:'Seu pedido',text:'Olá {{first_name|cliente}}',html:`<p><strong>HTML congelado ${tag}</strong></p>`,design:{}})})
      draftId=draft.id
      await api(`/api/email/drafts/${draft.id}/automation-node`,{method:'POST',body:JSON.stringify({automationId:id,nodeId:'mail'})})
      await api(`/api/automations/${id}/publish`,{method:'POST',body:'{}'})
      // A later draft edit cannot alter the already published snapshot.
      await api('/api/email/drafts',{method:'POST',body:JSON.stringify({id:draft.id,name:id,senderId:settings.defaultSenderId,subject:'Rascunho futuro',text:'Outro texto',html:'<p>Rascunho futuro</p>',design:{}})})
      await api('/api/email/dev/inbound',{method:'POST',body:JSON.stringify({from:to,to:initial.replyTo,messageId:`<flow-${tag}@exemplo.test>`,inReplyTo:first.messageId,text:keyword})})
      await expect.poll(async()=> (await api<{to:string;subject:string;html:string}[]>('/api/email/dev/outbox')).filter(row=>row.to===to).some(row=>row.subject===`Assunto congelado ${tag}`&&row.html.includes(`HTML congelado ${tag}`)),{timeout:30000}).toBe(true)
      await expect.poll(async()=> (await api<{to:string;text:string}[]>('/api/email/dev/outbox')).filter(row=>row.to===to).some(row=>row.text.includes(`Próximo passo ${tag}`)),{timeout:30000}).toBe(true)
    } finally {
      sql([`DELETE FROM contacts WHERE workspace_id='${WORKSPACE}' AND id IN (SELECT contact_id FROM contact_channels WHERE workspace_id='${WORKSPACE}' AND external_user_id='${q(to)}')`,`DELETE FROM email_receipts WHERE workspace_id='${WORKSPACE}' AND message_id='<flow-${tag}@exemplo.test>'`,`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${id}'`,...(draftId?[`DELETE FROM email_drafts WHERE workspace_id='${WORKSPACE}' AND id='${q(draftId)}'`]:[])])
    }
  })
})
