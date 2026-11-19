// Generate against an empty D1-shaped introspector, never a remote database.
import { getMigrations } from 'better-auth/db/migration'
import { writeFile } from 'node:fs/promises'
const database = {
  prepare() { return { bind() { return this }, async all() { return { results: [], meta: {} } } } },
  async batch() { return [] }, async exec() {},
}
const migration = await getMigrations({ database, rateLimit: { storage: 'database' } })
await writeFile('migrations/0002_auth.sql', '-- Generated with Better Auth getMigrations; npm run db:auth-schema\n' + await migration.compileMigrations() + '\n')
