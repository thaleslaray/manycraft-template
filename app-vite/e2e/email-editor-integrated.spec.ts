import { test, expect } from './fixtures'
import { api, consulta, novoTag, q, sql, WORKSPACE, caminhoPrint } from './helpers'

test('painel original configura e persiste o e-mail da automação', { tag: "@celular" }, async ({page}, info) => {
  await page.setViewportSize(info.project.name === 'desktop' ? {width:1440,height:900} : {width:390,height:844})
  const tag=novoTag(), id=`e2e-email-editor-${tag}`, subject=`Pedido integrado ${tag}`
  const settings=await api<{defaultSenderId:string}>('/api/email/settings')
  await api('/api/email/settings',{method:'PATCH',body:JSON.stringify({company:{name:'Empresa de estudo',address:'Rua de teste, 123'},paused:false})})
  const to=`editor-${tag}@exemplo.test`, tagId=`editor-tag-${tag}`
  const channel=consulta<{id:string}>(`SELECT id FROM channels WHERE workspace_id='${WORKSPACE}' AND id='email-channel-${WORKSPACE}'`)[0].id
  const graph={nodes:[{id:'trigger',type:'trigger',position:{x:0,y:0},config:{}},{id:'mail',type:'message',position:{x:250,y:0},config:{blocks:[{kind:'text',text:'Mensagem inicial'}]}},{id:'next',type:'message',position:{x:500,y:0},config:{blocks:[{kind:'text',text:'Continuação'}]}}],edges:[{from:'trigger',port:'next',to:'mail'},{from:'mail',port:'next',to:'next'}]}
  if(info.project.name === 'mobile') Object.assign(graph.nodes[1].config,{email:{subject,preheader:'Detalhes do pedido integrado',senderId:settings.defaultSenderId,text:'Mensagem inicial',html:'<p>Mensagem inicial</p>'}})
  sql([`INSERT INTO tags(id,workspace_id,name) VALUES ('${tagId}','${WORKSPACE}','Abriu ${tag}')`,`INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${id}','${WORKSPACE}','E-mail integrado ${tag}','${q(JSON.stringify(graph))}')`,`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES ('${id}-trg','${WORKSPACE}','${id}','${q(channel)}','Pedido','keyword','active','every_time','{"node_id":"trigger"}')`])
  try {
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    if(info.project.name === 'mobile') {
      await expect(page.getByRole('list',{name:'Passos da automação'})).toContainText(subject)
      await page.screenshot({path:caminhoPrint(`clone-screens/10b-email-automation-mobile.png`),scale:'css'})
      await page.goto(`/${WORKSPACE}/settings/email/design`)
      await expect(page.getByText('Preparando editor…',{exact:true})).toHaveCount(0,{timeout:30000})
      await page.getByRole('heading',{name:'Design da mensagem',exact:true}).scrollIntoViewIfNeeded()
      await page.screenshot({path:caminhoPrint(`clone-screens/10b-email-design-mobile.png`),scale:'css'})
      return
    }
    await page.locator('.react-flow__node[data-id="mail"]').click()
    const panel=page.getByRole('region',{name:'Mensagem de e-mail',exact:true})
    await expect(panel).toBeVisible()
    await panel.getByLabel('Remetente', {exact:true}).selectOption(settings.defaultSenderId)
    await panel.getByLabel('Assunto',{exact:true}).fill(subject)
    await panel.getByLabel('Prévia',{exact:true}).fill('Detalhes do pedido integrado')
    await panel.getByRole('button',{name:'Editar design',exact:true}).click()
    const dialog=page.getByRole('dialog',{name:'Design do e-mail',exact:true})
    await expect(dialog).toBeVisible()
    const studio=page.frameLocator('iframe[title="Editor visual de e-mail"]')
    await expect(studio.getByText('Configurações do e-mail',{exact:true})).toBeVisible({timeout:30000})
    await expect(studio.getByText('Email attributes',{exact:true})).toHaveCount(0)
    await expect(studio.getByText('Source code',{exact:true})).toHaveCount(0)
    await expect(studio.getByText('Font size (px)',{exact:true})).toHaveCount(0)
    await expect(studio.getByText('Atributos de E-mail',{exact:true})).toBeVisible()
    await page.screenshot({path:caminhoPrint(`clone-screens/10b-email-design-desktop.png`),scale:'css'})
    await dialog.getByRole('button',{name:'Aplicar design',exact:true}).click()
    await panel.getByRole('checkbox',{name:'Executar uma ação quando o contato abrir o e-mail'}).check()
    await panel.getByLabel('Aplicar tag ao abrir',{exact:true}).selectOption(tagId)
    await panel.getByText('Enviar teste simulado',{exact:true}).click()
    await panel.getByLabel('Destinatário de teste',{exact:true}).fill(to)
    await panel.getByRole('checkbox',{name:'Usar somente o transporte simulado local.'}).check()
    await panel.getByRole('button',{name:'Enviar teste',exact:true}).click()
    await expect(panel.getByRole('status')).toContainText(`Teste simulado registrado para ${to}.`)
    expect((await api<{to:string;subject:string}[]>('/api/email/dev/outbox')).some(row=>row.to===to&&row.subject===subject)).toBe(true)
    await page.getByRole('button',{name:'Salvar rascunho',exact:true}).click()
    await expect.poll(async()=> (await api<{automation:{draft_graph:typeof graph}}>(`/api/automations/${id}`)).automation.draft_graph.nodes.find(node=>node.id==='mail')?.config).toMatchObject({email:{subject,preheader:'Detalhes do pedido integrado',senderId:settings.defaultSenderId,onOpen:{mode:'once',actions:[{type:'add_tag',tag_id:tagId}]}}})
    await page.reload()
    await page.locator('.react-flow__node[data-id="mail"]').click()
    await expect(panel.getByLabel('Assunto',{exact:true})).toHaveValue(subject)
    await expect(panel.getByLabel('Prévia',{exact:true})).toHaveValue('Detalhes do pedido integrado')
    await expect(panel.getByText('Próximo passo vai para',{exact:true})).toBeVisible()
    await panel.getByLabel('Remetente',{exact:true}).scrollIntoViewIfNeeded()
    await page.screenshot({path:caminhoPrint(`clone-screens/10b-email-automation-desktop.png`),scale:'css'})
  } finally { sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${id}'`,`DELETE FROM contacts WHERE workspace_id='${WORKSPACE}' AND id IN (SELECT contact_id FROM contact_channels WHERE workspace_id='${WORKSPACE}' AND external_user_id='${q(to)}')`,`DELETE FROM tags WHERE workspace_id='${WORKSPACE}' AND id='${tagId}'`]) }
})

test('condição original persiste atividade de e-mail e segmento salvo', { tag: "@celular" }, async ({page},info) => {
  const tag=novoTag(), id=`e2e-email-condition-${tag}`, segmentId=`e2e-email-segment-${tag}`
  await page.setViewportSize(info.project.name==='desktop'?{width:1440,height:900}:{width:390,height:844})
  const graph={nodes:[{id:'trigger',type:'trigger',position:{x:0,y:0},config:{}},{id:'condition',type:'condition',position:{x:250,y:0},config:{match:'all',rules:[{type:'email',filter:'defined'}]}}],edges:[{from:'trigger',port:'next',to:'condition'}]}
  sql([`INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${id}','${WORKSPACE}','Condição de e-mail ${tag}','${q(JSON.stringify(graph))}')`,`INSERT INTO segments(id,workspace_id,name,filter) VALUES ('${segmentId}','${WORKSPACE}','Leitores ${tag}','{"match":"all","rules":[{"type":"email","filter":"opened"}]}')`])
  try {
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    if(info.project.name==='mobile') { await expect(page.getByRole('list',{name:'Passos da automação'})).toContainText('1 regras'); await page.screenshot({path:caminhoPrint('clone-screens/10b-email-condition-mobile.png'),scale:'css'}); return }
    await page.locator('.react-flow__node[data-id="condition"]').click()
    const panel=page.getByRole('region',{name:'Verificar condição',exact:true})
    await panel.getByLabel('Condição de e-mail',{exact:true}).click()
    await page.getByRole('option',{name:'Abriu e não clicou',exact:true}).click()
    await panel.getByRole('button',{name:'Adicionar regra',exact:true}).click()
    await panel.getByLabel('Regra 2',{exact:true}).click()
    await page.getByRole('option',{name:'Pertence a segmento',exact:true}).click()
    await panel.getByLabel('Segmento salvo',{exact:true}).click()
    await page.getByRole('option',{name:`Leitores ${tag}`,exact:true}).click()
    await page.getByRole('button',{name:'Salvar rascunho',exact:true}).click()
    await expect.poll(async()=> (await api<{automation:{draft_graph:{nodes:{id:string;config:unknown}[]}}}>(`/api/automations/${id}`)).automation.draft_graph.nodes.find(node=>node.id==='condition')?.config).toMatchObject({match:'all',rules:[{type:'email',filter:'opened_not_clicked'},{type:'segment',segment_id:segmentId,operator:'in'}]})
    await page.reload()
    await page.locator('.react-flow__node[data-id="condition"]').click()
    await expect(panel.getByLabel('Condição de e-mail',{exact:true})).toContainText('Abriu e não clicou')
    await expect(panel.getByLabel('Segmento salvo',{exact:true})).toContainText(`Leitores ${tag}`)
    await page.screenshot({path:caminhoPrint('clone-screens/10b-email-condition-desktop.png'),scale:'css'})
  } finally { sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${id}'`,`DELETE FROM segments WHERE workspace_id='${WORKSPACE}' AND id='${segmentId}'`]) }
})
