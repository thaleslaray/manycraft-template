// Trava exclusiva de suítes entre worktrees: arquivo test.lock no diretório comum do git.
import { execFileSync } from "node:child_process"
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { isAbsolute, resolve, join } from "node:path"

export function lockPath(cwd = process.cwd()) {
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" }).trim()
  return join(isAbsolute(common) ? common : resolve(cwd, common), "test.lock")
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === "EPERM" }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// O checkout principal (onde se juntam os ramos) tem prioridade: quem vem de worktree espera enquanto ele aguarda.
function isMainCheckout(cwd = process.cwd()) {
  const g = d => execFileSync("git", ["rev-parse", d], { cwd, encoding: "utf8" }).trim()
  return resolve(cwd, g("--git-dir")) === resolve(cwd, g("--git-common-dir"))
}

export async function acquireTestLock({ path = lockPath(), pollMs = 1000, log = console.error } = {}) {
  let warned = null
  const prio = path + ".prio"
  const principal = isMainCheckout()
  if (principal) { try { writeFileSync(prio, String(process.pid)) } catch {} }
  const clearPrio = () => { try { if (readFileSync(prio, "utf8").trim() === String(process.pid)) unlinkSync(prio) } catch {} }
  for (;;) {
    if (!principal) {
      let p = NaN
      try { p = Number.parseInt(readFileSync(prio, "utf8"), 10) } catch {}
      if (Number.isInteger(p) && alive(p)) { await sleep(pollMs); continue }
    }
    try {
      const fd = openSync(path, "wx")
      writeSync(fd, String(process.pid))
      closeSync(fd)
      if (principal) clearPrio()
      let released = false
      const release = () => {
        if (released) return
        released = true
        try { if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path) } catch {}
      }
      process.on("exit", release)
      for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { release(); process.exit(130) })
      return release
    } catch (e) {
      if (e.code !== "EEXIST") throw e
    }
    let owner = NaN
    try { owner = Number.parseInt(readFileSync(path, "utf8"), 10) } catch { continue }
    if (!Number.isInteger(owner) || !alive(owner)) {
      try { unlinkSync(path) } catch {}
      continue
    }
    if (warned !== owner) { log(`aguardando outra suíte (pid ${owner})`); warned = owner }
    await sleep(pollMs)
  }
}
