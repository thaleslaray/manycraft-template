import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { labels } from './locale-pt-br.mjs'
export function localizeEmailExtensions(source) {
  // Easy Email 4.17 embeds en-US in two internal Arco providers and offers no locale prop.
  const providers = source.match(/locale: enUS\b/g) ?? []
  if (providers.length !== 2) throw new Error('Revise a tradução dos provedores internos após atualizar o Easy Email.')
  // The "Json source" field reads the block back with eval("(" + text + ")"), which needs 'unsafe-eval' in the CSP. The text it shows is JSON.stringify
  // output, so JSON.parse reads the same thing; a syntax error reaches the same catch and shows the same error message.
  const evaluated = 'JSON.parse(JSON.stringify(eval("(" + event.target.value + ")")))'
  if (source.split(evaluated).length !== 2) throw new Error('Revise a leitura do JSON do código-fonte após atualizar o Easy Email.')
  const localized = source.replace(evaluated, 'JSON.parse(event.target.value)').replaceAll('locale: enUS', 'locale: reaPtBR')
    .replace(/(\b(?:label|title):\s*)"([^"]+)"/g, (match, prefix, text) => labels[text] ? `${prefix}${JSON.stringify(labels[text])}` : match)
    .replace('`${block2.name} `, " ", t("attributes")', 't("Attributes for ***", block2.name)')
  return `import reaPtBR from '@arco-design/web-react/es/locale/pt-BR';\n${localized}`
}
const directory = fileURLToPath(new URL('.', import.meta.url))
/** React 18 is isolated to this iframe. The app keeps its own React 19 runtime. */
export function emailStudioPlugin() {
  let files
  async function bundle() {
    if (files) return files
    const result = await build({entryPoints:[`${directory}editor.jsx`],bundle:true,write:false,outfile:'email-studio/editor.js',format:'iife',platform:'browser',minify:true,plugins:[{name:'email-studio-pt-br',setup(build){build.onLoad({filter:/easy-email-extensions\/lib\/index2\.js$/},async args=>({contents:localizeEmailExtensions(await readFile(args.path,'utf8')),loader:'js',resolveDir:dirname(args.path)}))}}],jsx:'automatic',alias:{react:'react18','react-dom':'react-dom18'},define:{'process.env.NODE_ENV':'"production"'},loader:{'.woff': 'dataurl','.woff2':'dataurl','.ttf':'dataurl','.svg':'dataurl'}})
    files = new Map(result.outputFiles.map(file => [`/email-studio/${file.path.split('/').at(-1)}`,file.contents]))
    files.set('/email-studio/index.html',new TextEncoder().encode('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/email-studio/editor.css"><body><div id="root"></div><script src="/email-studio/editor.js"></script></body></html>'))
    return files
  }
  return {name:'isolated-email-studio',async configureServer(server){const assets=await bundle();server.middlewares.use((request,response,next)=>{const name=request.url?.split('?')[0];if(!assets.has(name))return next();response.setHeader('Content-Type',name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html');response.end(assets.get(name))})},async buildStart(){await bundle()},generateBundle(){for(const [name,source] of files)this.emitFile({type:'asset',fileName:name.slice(1),source})}}
}
