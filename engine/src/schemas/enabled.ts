import { z } from 'zod'

/** Corpo `{ "enabled": true | false }`, sem outros campos: liga ou desliga algo (conexão, Pixel, encurtador de links). */
export const enabledSchema = z.object({ enabled: z.boolean() }).strict()
