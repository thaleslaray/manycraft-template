import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BlockManager, BasicType, AdvancedType, JsonToMjml, I18nManager } from 'easy-email-core'
import { EmailEditor, EmailEditorProvider } from 'easy-email-editor'
import { StandardLayout } from 'easy-email-extensions'
import mjml from 'mjml-browser'
import 'easy-email-editor/lib/style.css'
import 'easy-email-extensions/lib/style.css'
import '@arco-themes/react-easy-email-theme/css/arco.css'
import './studio.css'
const send = message => parent.postMessage({ source: 'rea-email-studio', ...message }, location.origin)
import { labels } from './locale-pt-br.mjs'
// Core block titles and the extension controls use the same catalogue.
I18nManager.setLocaleData(labels)
const button = BlockManager.getBlockByType(BasicType.BUTTON)
const createButton = button.create
button.create = payload => {
 const block = createButton(payload)
 if (!payload?.data?.value?.content) block.data.value.content = 'Saiba mais'
 return block
}
const categories = [{label:'Conteúdo',active:true,blocks:[{type:AdvancedType.TEXT,title:'Texto e título'},{type:AdvancedType.BUTTON,title:'Botão com link'},{type:AdvancedType.IMAGE,title:'Imagem'},{type:AdvancedType.DIVIDER,title:'Divisor'},{type:AdvancedType.SPACER,title:'Espaço'}]},{label:'Estrutura',blocks:[{type:BasicType.SECTION,title:'Seção'},{type:BasicType.COLUMN,title:'Coluna'},{type:BasicType.WRAPPER,title:'Área'}]}]
async function uploadImage(file) {
 if (!['image/png','image/jpeg','image/gif'].includes(file.type)) throw new Error('Use uma imagem PNG ou JPEG.')
 if (file.size > 5 * 1024 * 1024) throw new Error('A imagem deve ter até 5 MB.')
 const url=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file)})
 if(file.type !== 'image/gif') return url
 const image=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=reject;img.src=url})
 const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;canvas.getContext('2d').drawImage(image,0,0)
 return canvas.toDataURL('image/png')
}
function Report({values}) { useEffect(()=>{const timer=setTimeout(()=>{try {const html=mjml(JsonToMjml({data:values.content,mode:'production',context:values.content}),{validationLevel:'soft'}).html;const doc=new DOMParser().parseFromString(html,'text/html');send({type:'change',design:values,html,text:doc.body.textContent || ''})} catch(error) {send({type:'error',message:error.message})}},300);return()=>clearTimeout(timer)},[values]);return null }
function App(){const [initial,setInitial]=useState(null);useEffect(()=>{function receive(event){if(event.origin !== location.origin || event.source !== parent || event.data?.source !== 'rea-email-panel')return;const {design,theme}=event.data;for(const [key,value] of Object.entries(theme || {}))document.documentElement.style.setProperty(key,value);setInitial(design || {subject:'',subTitle:'',content:BlockManager.getBlockByType(BasicType.PAGE).create({children:[BlockManager.getBlockByType(AdvancedType.TEXT).create({data:{value:{content:'<h1>Vamos conversar?</h1><p>Escreva aqui a mensagem para o seu contato.</p>'}}})]})})}window.addEventListener('message',receive);send({type:'ready'});return()=>window.removeEventListener('message',receive)},[]);if(!initial)return <p>Preparando editor…</p>;return <EmailEditorProvider data={initial} height="100vh" locale={labels} autoComplete dashed={false} onUploadImage={uploadImage} fontList={[{label:'Arial',value:'Arial'},{label:'Verdana',value:'Verdana'},{label:'Georgia',value:'Georgia'}]}>{({values})=><><Report values={values}/><StandardLayout categories={categories} showSourceCode><EmailEditor/></StandardLayout></>}</EmailEditorProvider>}
createRoot(document.getElementById('root')).render(<App/>)
