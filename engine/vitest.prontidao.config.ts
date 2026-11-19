import { mergeConfig } from 'vitest/config'
import base from './vitest.config'

/** Teste de prontidão completo (npm run prontidao): inclui o estresse, que é lento demais para o `npm test`. */
export default mergeConfig(base, { test: { provide: { prontidaoContatos: Number(process.env.PRONTIDAO_CONTATOS ?? 1000) }, include: ['./test/prontidao/**/*.{test,stress}.ts'], testTimeout: 900_000, hookTimeout: 900_000 } })
