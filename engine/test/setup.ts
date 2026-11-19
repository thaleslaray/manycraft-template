import { applyD1Migrations, type D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import type { Env as RuntimeEnv } from '../src/env'

declare global {
  namespace Cloudflare {
    interface GlobalProps { mainModule: typeof import("../src/flow/entry") }
    interface Env extends RuntimeEnv {
      TEST_MIGRATIONS: D1Migration[]
      FLOW_RUN: Workflow<{ runId: string }>
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
