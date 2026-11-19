import { createServer } from 'node:http'
import { readFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from './fixtures'
import { WORKSPACE, acaoDoTopo, api, sql, q, novoTag, pastaPrints } from './helpers'
import { encryptCredentials } from '../../engine/src/channels/core/crypto'

test('modelos por conexão: rascunho, revisão travada, sincronização e transmissão', { tag: "@celular" }, async ({ page }, info) => {
  const tag=novoTag(), id=`e2e-modelos-${tag}`, name=`pedido_${tag}`
  const catalog=await api<{development?:{providerApiBase:string}}>('/api/connections/catalog')
  expect(catalog.development, 'O ambiente local precisa apontar para HTTP falso').toBeTruthy()
  const base=catalog.development!.providerApiBase
  expect(new URL(base).hostname).toBe('127.0.0.1')
  const vars=readFileSync(resolve(import.meta.dirname,'../../engine/.dev.vars'),'utf8')
  const version=vars.match(/^CONNECTIONS_KEK_ACTIVE=["']?(\d+)/m)![1]
  const key=vars.match(new RegExp(`^CONNECTIONS_KEK_V${version}=["']?([^\\r\\n"']+)`,'m'))![1]
  const sealed=await encryptCredentials({CONNECTIONS_KEK_ACTIVE:version,[`CONNECTIONS_KEK_V${version}`]:key},{workspaceId:WORKSPACE,connectionId:id},{accessToken:'TESTONLY',phoneNumberId:'123',wabaId:'456'})
  let approved=false
  const submitted:Record<string,unknown>[]=[]
  const server=createServer((req,res)=>{
    const chunks:Buffer[]=[]
    req.on('data',c=>chunks.push(c));req.on('end',()=>{
      res.setHeader('content-type','application/json')
      res.setHeader('connection','close')
      if(!req.url?.startsWith('/v26.0/456/message_templates')){res.statusCode=404;return res.end('{}')}
      if(req.method==='POST'){submitted.push(JSON.parse(Buffer.concat(chunks).toString()));return res.end(JSON.stringify({id:'fake-template',status:'PENDING',category:'UTILITY'}))}
      res.end(JSON.stringify({data:[{id:'fake-template',name,language:'pt_BR',status:approved?'APPROVED':'PENDING',category:'UTILITY',quality_score:{score:approved?'GREEN':'UNKNOWN'}}]}))
    })
  })
  await new Promise<void>((ok,fail)=>{server.once('error',fail);server.listen(Number(new URL(base).port),'127.0.0.1',ok)})
  const shots=pastaPrints("clone-screens");mkdirSync(shots,{recursive:true})
  const device=info.project.name==='desktop'?'desktop':'mobile'
  await page.setViewportSize(device==='desktop'?{width:1440,height:900}:{width:390,height:844})
  try {
    sql([`INSERT INTO channels(id,workspace_id,type,provider,external_id,status,connection_state,display_name,settings,credentials_ciphertext,credentials_iv,credentials_key_version) VALUES ('${id}','${WORKSPACE}','whatsapp','meta_whatsapp_cloud','${id}-ext','connected','connected','Oficina de testes','${q(JSON.stringify({apiBase:base}))}','${sealed.ciphertext}','${sealed.iv}',${sealed.keyVersion})`,
      `INSERT INTO channels(id,workspace_id,type,provider,external_id,display_name) VALUES ('${id}-uz','${WORKSPACE}','whatsapp','uazapi','${id}-uz','Sem modelos')`])
    await page.goto(`/${WORKSPACE}/settings/message-templates`)
    await expect(page.getByRole('heading',{name:'Modelos de mensagem',exact:true})).toBeVisible()
    await page.getByLabel('Conexão dos modelos').selectOption(id)
    await expect(page.getByLabel('Conexão dos modelos').getByRole('option',{name:'Sem modelos'})).toHaveCount(0)
    await page.getByRole('button',{name:'Novo modelo',exact:true}).click()
    await page.getByLabel('Nome do modelo').fill(name)
    await page.getByLabel('Corpo da mensagem').fill('Olá {{1}}, seu pedido foi confirmado. Estamos preparando tudo para você.')
    await page.getByLabel('Exemplo da variável 1', {exact:true}).fill('Nara')
    await page.getByLabel('Rodapé').fill('Oficina Horizonte')
    await page.screenshot({path:resolve(shots,`30-modelos-editor-${device}.png`)})
    await page.getByRole('button',{name:'Salvar rascunho',exact:true}).click()
    await expect(page.getByRole('button',{name:name,exact:true})).toBeVisible()
    expect(submitted).toHaveLength(0)
    await page.reload()
    await page.getByRole('button',{name:name,exact:true}).click()
    await expect(page.getByLabel('Corpo da mensagem')).toHaveValue(/pedido foi confirmado/)
    await page.getByRole('button',{name:'Enviar para revisão',exact:true}).click()
    await expect(page.getByText('Em revisão',{exact:true}).first()).toBeVisible()
    await page.getByRole('button',{name:name,exact:true}).click()
    await expect(page.getByLabel('Corpo da mensagem')).toBeDisabled()
    expect(submitted).toHaveLength(1)
    await page.getByRole('button',{name:'Voltar aos modelos',exact:true}).click()
    approved=true
    await page.getByRole('button',{name:'Atualizar modelos',exact:true}).click()
    await expect(page.getByText('Aprovado',{exact:true})).toBeVisible()
    await expect(page.getByText('Alta',{exact:true})).toBeVisible()
    await page.screenshot({path:resolve(shots,`30-modelos-lista-${device}.png`)})
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
    await page.goto(`/${WORKSPACE}/broadcasts`)
    await acaoDoTopo(page,'Nova transmissão')
    await page.getByLabel('Canal conectado',{exact:true}).click()
    await page.getByRole('option',{name:'Oficina de testes',exact:true}).click()
    await page.getByLabel('Tipo da transmissão',{exact:true}).click()
    await page.getByRole('option',{name:'Fora da janela / promocional',exact:true}).click() // WhatsApp oficial: o tipo define o conteúdo (promocional = modelo aprovado)
    await page.getByLabel('Modelo do canal',{exact:true}).click()
    await expect(page.getByRole('option',{name:new RegExp(name)})).toHaveCount(1)
    await page.screenshot({path:resolve(shots,`30-modelos-transmissao-${device}.png`)})
  } finally {
    await new Promise<void>((ok,fail)=>server.close(error=>error?fail(error):ok()))
    sql([`DELETE FROM channels WHERE workspace_id='${WORKSPACE}' AND id IN ('${id}','${id}-uz')`])
  }
})
