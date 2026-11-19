import { test, expect } from './fixtures'
import { acaoDoTopo, api, consulta, escolher, novoTag, q, sql, WORKSPACE, caminhoPrint } from './helpers'

test('transmissão de e-mail guarda design no painel original e mostra aberturas/cliques do envio', { tag: "@celular" }, async ({ page }) => {
  const tag = novoTag(), name = `E-mail ${tag}`, subject = `Notícias ${tag}`, to = `e2e-broadcast-${tag}@exemplo.test`
  let draftId: string | undefined, broadcastId: string | undefined
  try {
    const settings = await api<{ defaultSenderId:string }>('/api/email/settings')
    await api('/api/email/settings', {method:'PATCH',body:JSON.stringify({company:{name:'Oficina de teste',address:'Rua de estudo, 123'},paused:false})})
    await api('/api/email/test', {method:'POST',body:JSON.stringify({senderId:settings.defaultSenderId,to,subject:'Boas-vindas',text:'Olá',consent:true})})
    const draft = await api<{id:string}>('/api/email/drafts',{method:'POST',body:JSON.stringify({name,senderId:settings.defaultSenderId,subject,preheader:'Confira as novidades',text:'Veja os detalhes',html:'<p>Veja os detalhes</p><a href="https://exemplo.test/detalhes">Abrir detalhes</a>',design:{}})})
    draftId = draft.id
    const connection = consulta<{channel_id:string}>(`SELECT channel_id FROM contact_channels WHERE workspace_id='${WORKSPACE}' AND external_user_id='${q(to)}'`)[0].channel_id
    await page.setViewportSize(test.info().project.name === 'desktop' ? {width:1440,height:900} : {width:390,height:844})
    await page.goto(`/${WORKSPACE}/broadcasts`)
    await acaoDoTopo(page,'Nova transmissão')
    await page.getByLabel('Nome da transmissão',{exact:true}).fill(name)
    await escolher(page,'Canal conectado',consulta<{display_name:string}>(`SELECT display_name FROM channels WHERE id='${q(connection)}'`)[0].display_name)
    await escolher(page,'Design de e-mail',name)
    await expect(page.getByLabel('Assunto',{exact:true})).toHaveValue(subject)
    await acaoDoTopo(page,'Salvar rascunho')
    await expect(page).toHaveURL(/\/broadcasts$/)
    const saved = (await api<{id:string;name:string;email:{subject:string}}[]>('/api/broadcasts')).find(row=>row.name===name)!
    broadcastId=saved.id
    expect(saved.email.subject).toBe(subject)
    await page.reload()
    await page.getByRole('button',{name:`Editar ${name}`,exact:true}).click()
    await expect(page.getByLabel('Assunto',{exact:true})).toHaveValue(subject)
    await page.screenshot({path:caminhoPrint(`clone-screens/10b-broadcast-editor-${test.info().project.name}.png`),scale:'css',animations:'disabled'})
    await acaoDoTopo(page,'Enviar agora')
    await page.getByRole('button',{name:'Confirmar envio',exact:true}).click()
    await expect(page).toHaveURL(/\/broadcasts$/)
    await expect.poll(async()=> (await api<{status:string}>(`/api/broadcasts/${saved.id}`)).status,{timeout:30000}).toBe('sent')
    const outbound=(await api<{id:string;subject:string;html:string;to:string}[]>('/api/email/dev/outbox')).find(row=>row.to===to&&row.subject===subject)!
    expect(outbound).toBeTruthy()
    const pixel=outbound.html.match(/src="([^"]*\/api\/email-public\/open\/[^\"]+)"/)![1]
    const click=outbound.html.match(/href="([^"]*\/api\/email-public\/click\/[^\"]+)"/)![1]
    await page.request.get(pixel)
    await page.request.get(pixel)
    await page.request.get(click,{maxRedirects:0})
    await api('/api/email/dev/events',{method:'POST',body:JSON.stringify({id:outbound.id,type:'delivered'})})
    await page.getByRole('button',{name:`Ver relatório de ${name}`,exact:true}).click()
    // Lateral enxuta: os números de abertura e clique moram no nó do mapa; a legenda abre pelo ⓘ ao lado do título.
    const lateral=page.getByRole('complementary',{name:'Principais métricas'})
    await expect(lateral.getByText('E-mails',{exact:true})).toBeVisible()
    const noMapa=page.getByRole('application',{name:'Mapa do fluxo enviado'})
    await expect(noMapa.getByText('E-mail',{exact:true}).first()).toBeVisible()
    await expect(noMapa.getByText('Canal não definido')).toHaveCount(0)
    const metricas=noMapa.getByRole('group',{name:'Métricas da mensagem'})
    await expect(metricas.getByText('Aberto',{exact:true})).toBeVisible()
    await expect(metricas.getByText('Clicado',{exact:true})).toBeVisible()
    await lateral.getByRole('button',{name:'Situação e como ler os resultados'}).click()
    await expect(page.getByText(/Pixel carregado/)).toBeVisible()
    await expect(page.getByText(/primeiro nó/)).toBeVisible()
    await page.keyboard.press('Escape')
    const report=await api<{metrics:{opened:number;clicked:number;ctr:number}}>(`/api/broadcasts/${saved.id}`)
    expect(report.metrics.opened).toBe(1)
    expect(report.metrics.clicked).toBe(1)
    expect(report.metrics.ctr).toBeGreaterThan(0)
    await page.screenshot({path:caminhoPrint(`clone-screens/10b-broadcast-history-${test.info().project.name}.png`),scale:'css',animations:'disabled'})
  } finally {
    sql([`DELETE FROM broadcasts WHERE workspace_id='${WORKSPACE}' AND name='${q(name)}'`,...(broadcastId?[`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='broadcast-${q(broadcastId)}'`]:[]),...(draftId?[`DELETE FROM email_drafts WHERE workspace_id='${WORKSPACE}' AND id='${q(draftId)}'`]:[]),`DELETE FROM contacts WHERE workspace_id='${WORKSPACE}' AND id IN (SELECT contact_id FROM contact_channels WHERE workspace_id='${WORKSPACE}' AND external_user_id='${q(to)}')`])
  }
})
