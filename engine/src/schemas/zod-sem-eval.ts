import { z } from "zod"

/** Importado primeiro pelo painel (app-vite/src/main.tsx): os esquemas daqui validam sem compilar código com `new Function`,
 * então a CSP do painel não precisa de 'unsafe-eval'. Precisa rodar antes do primeiro parse: o Zod guarda a sonda de eval na primeira leitura.
 * O motor não precisa: no Workers o Zod já desliga o JIT sozinho. */
z.config({ jitless: true })
