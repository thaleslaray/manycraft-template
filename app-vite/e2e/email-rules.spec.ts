import { test, expect } from './fixtures'
import { api, consulta, novoTag, q, sql, WORKSPACE, caminhoPrint } from './helpers'

test('regra global de e-mail salva filtro e frequência', { tag: "@celular" }, async ({page})=>{
  const tag=novoTag(), id=`e2e-email-rule-flow-${tag}`, name=`Regra de abertura ${tag}`
  let ruleId:string|undefined
  const graph={nodes:[{id:'t',type:'trigger',position:{x:0,y:0},config:{}},{id:'m',type:'message',position:{x:250,y:0},config:{blocks:[{kind:'text',text:'Olá'}]}}],edges:[{from:'t',port:'next',to:'m'}]}
  sql([`INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${id}','${WORKSPACE}','Fluxo ${tag}','${q(JSON.stringify(graph))}')`])
  try {
    await api(`/api/automations/${id}/publish`,{method:'POST',body:'{}'})
    await page.setViewportSize(test.info().project.name==='desktop'?{width:1440,height:900}:{width:390,height:844})
    await page.goto(`/${WORKSPACE}/automations/rules`)
    await page.getByRole('link',{name:'Regras de e-mail',exact:true}).click()
    // As regras globais também têm "Criar regra": com a máquina carregada o clique caía no pop-up delas antes de a página de e-mail abrir.
    await expect(page).toHaveURL(new RegExp(`/${WORKSPACE}/automations/email-rules`))
    await expect(page.getByRole('link',{name:'Voltar às regras globais'})).toBeVisible()
    await page.getByRole('button',{name:'Criar regra',exact:true}).first().click()
    await page.getByLabel('Nome da regra',{exact:true}).fill(name)
    await page.getByLabel('Quando acontecer',{exact:true}).selectOption('email_opened')
    await page.getByLabel('Automação a iniciar',{exact:true}).selectOption(id)
    await page.getByLabel('Frequência',{exact:true}).selectOption('once')
    await page.getByRole('button',{name:'Adicionar condição',exact:true}).click()
    await page.getByLabel('Condição 1',{exact:true}).selectOption('opened_not_clicked')
    await page.getByRole('button',{name:'Salvar regra',exact:true}).click()
    await expect(page.getByRole('button',{name:`Editar ${name}`,exact:true})).toBeVisible()
    const rule=(await api<{id:string;name:string;frequency:string;filter:unknown}[]>('/api/email/rules')).find(r=>r.name===name)!
    ruleId=rule.id
    expect(rule.frequency).toBe('once')
    expect(rule.filter).toMatchObject({match:'all',rules:[{type:'email',filter:'opened_not_clicked'}]})
    await page.reload()
    await page.getByRole('button',{name:`Editar ${name}`,exact:true}).click()
    await expect(page.getByLabel('Frequência',{exact:true})).toHaveValue('once')
    await expect(page.getByLabel('Condição 1',{exact:true})).toHaveValue('opened_not_clicked')
    await page.screenshot({path:caminhoPrint(`clone-screens/10b-email-rules-${test.info().project.name}.png`),scale:'css',animations:'disabled'})
  }finally{
    if(ruleId) await api(`/api/email/rules/${ruleId}`,{method:'DELETE'})
    sql([`DELETE FROM rules WHERE workspace_id='${WORKSPACE}' AND automation_id='${id}'`,`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${id}'`])
  }
})

test('saída configurada no painel confirma STOP uma vez e executa a automação sem reativar marketing', { tag: "@celular" },async({page})=>{
  const suffix=novoTag(), id=`e2e-email-stop-${suffix}`, tagId=`e2e-email-stop-tag-${suffix}`, to=`e2e-stop-${suffix}@exemplo.test`
  let connectionId='', original:unknown
  const graph={nodes:[{id:'t',type:'trigger',position:{x:0,y:0},config:{}},{id:'a',type:'action',position:{x:250,y:0},config:{actions:[{type:'add_tag',tag_id:tagId}]}},{id:'m',type:'message',position:{x:500,y:0},config:{blocks:[{kind:'text',text:`Marketing bloqueado ${suffix}`}]}}],edges:[{from:'t',port:'next',to:'a'},{from:'a',port:'next',to:'m'}]}
  try{
    await api('/api/email/settings')
    await api('/api/email/settings',{method:'PATCH',body:JSON.stringify({company:{name:'Empresa de estudo',address:'Rua A, 123'},paused:false})})
    const sent=await api<{id:string;messageId:string;contactId:string}>('/api/email/test',{method:'POST',body:JSON.stringify({to,subject:'Conversa',text:'Responda por aqui',consent:true})})
    connectionId=consulta<{channel_id:string}>(`SELECT channel_id FROM contact_channels WHERE workspace_id='${WORKSPACE}' AND contact_id='${q(sent.contactId)}'`)[0].channel_id
    original=await api(`/api/email/connections/${connectionId}/stop`)
    sql([`INSERT INTO tags(id,workspace_id,name) VALUES ('${tagId}','${WORKSPACE}','Saída ${suffix}')`,`INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${id}','${WORKSPACE}','Saída ${suffix}','${q(JSON.stringify(graph))}')`])
    await api(`/api/automations/${id}/publish`,{method:'POST',body:'{}'})
    await page.setViewportSize(test.info().project.name==='desktop'?{width:1440,height:900}:{width:390,height:844})
    await page.goto(`/${WORKSPACE}/settings/email`)
    const section=page.getByRole('region',{name:'Automação de descadastro de e-mail'})
    await section.getByLabel('Conexão da saída',{exact:true}).selectOption(connectionId)
    await section.getByRole('checkbox',{name:'Executar confirmação e automação após descadastro'}).check()
    await section.getByLabel('Assunto da confirmação',{exact:true}).fill(`Saída confirmada ${suffix}`)
    await section.getByLabel('Mensagem de confirmação',{exact:true}).fill('Seu descadastro foi confirmado.')
    await section.getByLabel('Automação após STOP',{exact:true}).selectOption(id)
    await section.getByRole('button',{name:'Salvar saída de e-mail',exact:true}).click()
    await expect.poll(async()=>await api(`/api/email/connections/${connectionId}/stop`)).toMatchObject({enabled:true,automationId:id})
    await page.reload()
    await expect(section.getByLabel('Automação após STOP',{exact:true})).toHaveValue(id)
    await section.scrollIntoViewIfNeeded()
    await page.screenshot({path:caminhoPrint(`clone-screens/10b-email-stop-${test.info().project.name}.png`),scale:'css',animations:'disabled'})
    const out=(await api<{id:string;replyTo:string}[]>('/api/email/dev/outbox')).find(row=>row.id===sent.id)!
    const input={from:to,to:out.replyTo,inReplyTo:sent.messageId,messageId:`<stop-${suffix}@exemplo.test>`,text:'STOP'}
    await api('/api/email/dev/inbound',{method:'POST',body:JSON.stringify(input)})
    await api('/api/email/dev/inbound',{method:'POST',body:JSON.stringify(input)})
    await expect(async()=>expect(consulta<{n:number}>(`SELECT count(*) n FROM contact_tags WHERE contact_id='${q(sent.contactId)}' AND tag_id='${tagId}'`)[0].n).toBe(1)).toPass({timeout:30000})
    expect((await api<{subject:string}[]>('/api/email/dev/outbox')).filter(row=>row.subject===`Saída confirmada ${suffix}`)).toHaveLength(1)
    expect((await api<{text:string}[]>('/api/email/dev/outbox')).some(row=>row.text.includes(`Marketing bloqueado ${suffix}`))).toBe(false)
    expect(consulta<{opted_in:number}>(`SELECT opted_in FROM contact_channels WHERE contact_id='${q(sent.contactId)}' AND channel_id='${q(connectionId)}'`)[0].opted_in).toBe(0)
  }finally{
    if(connectionId&&original)await api(`/api/email/connections/${connectionId}/stop`,{method:'PUT',body:JSON.stringify(original)})
    sql([`DELETE FROM contacts WHERE workspace_id='${WORKSPACE}' AND id IN (SELECT contact_id FROM contact_channels WHERE workspace_id='${WORKSPACE}' AND external_user_id='${q(to)}')`,`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${id}'`,`DELETE FROM tags WHERE workspace_id='${WORKSPACE}' AND id='${tagId}'`,`DELETE FROM email_receipts WHERE workspace_id='${WORKSPACE}' AND message_id='<stop-${suffix}@exemplo.test>'`])
  }
})
