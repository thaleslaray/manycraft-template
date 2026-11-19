import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readdirSync, mkdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkMigrations, modifiedCommitted } from "./check-migrations.mjs"

function dirWith(names) {
  const d = mkdtempSync(join(tmpdir(), "mig-"))
  for (const n of names) writeFileSync(join(d, n), "-- x")
  return readdirSync(d)
}

test("sequência limpa passa", () => {
  assert.deepEqual(checkMigrations(dirWith(["0001_a.sql", "0002_b.sql", "0003_c.sql"])), [])
})
test("prefixo repetido falha", () => {
  const e = checkMigrations(dirWith(["0001_a.sql", "0002_b.sql", "0002_c.sql"]))
  assert.equal(e.length, 1); assert.match(e[0], /repetido/)
})
test("buraco falha", () => {
  const e = checkMigrations(dirWith(["0001_a.sql", "0003_c.sql"]))
  assert.match(e[0], /buraco/)
})
test("migração commitada modificada falha; nova (A) é ok", () => {
  const f = dirWith(["0001_a.sql", "0002_b.sql"])
  assert.match(checkMigrations(f, ["engine/migrations/0001_a.sql"])[0], /modificada/)
  assert.deepEqual(checkMigrations(f, []), [])
})
test("nome sem prefixo falha", () => {
  assert.match(checkMigrations(dirWith(["abc.sql"]))[0], /sem prefixo/)
})
test("--cached pega edição staged mesmo com a árvore de trabalho desfeita", () => {
  const d = mkdtempSync(join(tmpdir(), "mig-git-"))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")))
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, encoding: "utf8", env })
  const mig = join(d, "engine/migrations/0001_a.sql")
  git("init", "-q"); mkdirSync(join(d, "engine/migrations"), { recursive: true })
  writeFileSync(mig, "-- x"); git("add", "."); git("commit", "-qm", "base")
  writeFileSync(mig, "-- editada"); git("add", ".")
  assert.deepEqual(modifiedCommitted(d, true), ["engine/migrations/0001_a.sql"])
  writeFileSync(mig, "-- x") // staged editado, árvore igual ao HEAD: só --cached enxerga
  assert.deepEqual(modifiedCommitted(d, true), ["engine/migrations/0001_a.sql"])
  assert.deepEqual(modifiedCommitted(d), [])
})
