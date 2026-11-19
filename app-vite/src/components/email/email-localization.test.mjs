import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { localizeEmailExtensions } from '../../email-studio/build.mjs'
import { labels } from '../../email-studio/locale-pt-br.mjs'

test('catálogo pt-BR cobre os controles e descrições da versão instalada do Easy Email', () => {
  const source=readFileSync(new URL('../../../node_modules/easy-email-extensions/lib/index2.js',import.meta.url),'utf8')
  const keys=[...source.matchAll(/\bt\(\s*(['"`])((?:(?!\1)[\s\S])*?)\1\s*\)/g)].map(match=>match[2])
  assert.ok(keys.length>200)
  assert.deepEqual([...new Set(keys)].filter(key=>!labels[key]),[])
  const localized=localizeEmailExtensions(source)
  assert.ok(localized.includes('locale: reaPtBR'))
  assert.ok(!localized.includes('locale: enUS'))
  assert.ok(!localized.includes('label: \"Font size (px)\"'))
  assert.ok(!localized.includes('`${block2.name} `, \" \", t(\"attributes\")'))
  assert.equal(labels.Page,'E-mail')
  assert.equal(labels['Source code'],'Código-fonte')
})

test('o código-fonte JSON do estúdio lê o bloco sem eval (o estúdio roda sem unsafe-eval na CSP)', () => {
  const source=readFileSync(new URL('../../../node_modules/easy-email-extensions/lib/index2.js',import.meta.url),'utf8')
  const localized=localizeEmailExtensions(source)
  assert.ok(!/\beval\(\s*["'`]\(/.test(localized))
  assert.ok(localized.includes('const parseValue = JSON.parse(event.target.value);'))
})
