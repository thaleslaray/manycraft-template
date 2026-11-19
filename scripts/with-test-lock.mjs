#!/usr/bin/env node
// Uso: node scripts/with-test-lock.mjs <comando...>  — roda o comando com a trava de suítes.
import { spawn } from "node:child_process"
import { acquireTestLock } from "./test-lock.mjs"

const cmd = process.argv.slice(2)
if (!cmd.length) { console.error("uso: with-test-lock.mjs <comando...>"); process.exit(2) }
const release = await acquireTestLock()
const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit" })
child.on("exit", (code, sig) => { release(); process.exit(code ?? (sig ? 1 : 0)) })
child.on("error", e => { release(); console.error(e.message); process.exit(127) })
