import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { execFile, execFileSync, spawn } from "node:child_process"
import { promisify } from "node:util"

export const run = promisify(execFile)
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const hash = (value) => createHash("sha256").update(value).digest("hex")

export function realState() {
  const data = process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share")
  const config = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  const db = join(data, "opencode/opencode.db")
  const count = existsSync(db) ? Number(execFileSync("sqlite3", ["-readonly", db, "SELECT count(*) FROM session"], { encoding: "utf8" }).trim()) : null
  const files = [join(config, "opencode/opencode.json"), join(config, "opencode/opencode.jsonc"), join(config, "opencode/cli.json"), join(homedir(), ".omo/omo.json"), join(homedir(), ".omo/omo.jsonc")]
  return { db, sessionCount: count, configs: Object.fromEntries(files.map((file) => [file, existsSync(file) ? hash(readFileSync(file)) : null])) }
}

export async function sandbox(providerURL) {
  const root = await mkdtemp(join(tmpdir(), "omo-opencode-v2-qa-"))
  const project = join(root, "project")
  const env = { PATH: process.env.PATH, TERM: "xterm-256color", LANG: "C.UTF-8", HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
    OMO_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OMO_QA_API_KEY: "local-fixture-only", OPENCODE_SERVER_PASSWORD: "omo-qa-local-only" }
  await Promise.all([project, ...Object.values(env).filter((value) => typeof value === "string" && value.startsWith(root))].map((dir) => mkdir(dir, { recursive: true })))
  const model = "qa/qa-model"
  const config = { model, update: "disable", snapshots: false, permissions: [{ action: "*", resource: "*", effect: "allow" }], providers: {
    qa: { name: "Local deterministic QA", package: "@opencode/ai/providers/openai-compatible", env: ["OMO_QA_API_KEY"], settings: { baseURL: providerURL },
      models: { "qa-model": { name: "QA model", limit: { context: 200000, output: 16000 }, capabilities: { tools: true } } } },
  } }
  await mkdir(join(project, ".opencode/skills/qa-proof"), { recursive: true })
  await writeFile(join(project, ".opencode/skills/qa-proof/SKILL.md"), "---\nname: qa-proof\ndescription: Local deterministic test skill\n---\nOMO_QA_SKILL_BODY\n")
  await mkdir(join(project, ".opencode/skills/qa-denied-proof"), { recursive: true })
  await writeFile(join(project, ".opencode/skills/qa-denied-proof/SKILL.md"), "---\nname: qa-denied-proof\ndescription: Native agent permission regression skill\n---\nOMO_QA_AGENT_DENIED_BODY\n")
  await writeFile(join(project, "qa-proof.txt"), "OMO_QA_READ_LINE\nSecond line\nThird line\n")
  const pluginConfig = { disabled_mcps: ["websearch", "context7", "grep_app", "lsp"], auto_update: false, disabled_hooks: ["auto-update-checker"], hashline_edit: true,
    agents: Object.fromEntries(["sisyphus", "hephaestus", "oracle", "librarian", "explore", "multimodal-looker", "metis", "momus", "atlas", "prometheus", "sisyphus-junior"].map((agent) => [agent, { model }])),
    categories: Object.fromEntries(["quick", "deep", "unspecified-low", "unspecified-high", "visual-engineering", "ultrabrain", "artistry", "writing"].map((category) => [category, { model }])),
  }
  await mkdir(join(project, ".omo"), { recursive: true })
  await writeFile(join(project, ".omo/omo.jsonc"), JSON.stringify({ "[opencode]": pluginConfig }))
  return { root, project, env, config, remove: () => rm(root, { recursive: true, force: true }) }
}

export async function startHost(bin, box, evidence, label) {
  const server = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: box.project, env: box.env, stdio: ["ignore", "pipe", "pipe"], detached: true })
  let log = ""
  server.stdout.on("data", (data) => { log += data })
  server.stderr.on("data", (data) => { log += data })
  for (let i = 0; i < 300; i++) {
    const match = log.match(/https?:\/\/127\.0\.0\.1:\d+/)
    if (match) return { server, url: match[0], stop: async () => {
      try { process.kill(-server.pid, "SIGTERM") } catch {}
      await Promise.race([new Promise((resolve) => server.once("close", resolve)), pause(2000)])
      try { process.kill(-server.pid, "SIGKILL") } catch {}
      await writeFile(join(evidence, `${label}-server.log`), log)
    } }
    if (server.exitCode !== null) throw new Error(`host exited ${server.exitCode}: ${log.slice(-3000)}`)
    await pause(100)
  }
  try { process.kill(-server.pid, "SIGKILL") } catch {}
  throw new Error(`server did not publish URL: ${log.slice(-3000)}`)
}

export function api(url) {
  return async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from("opencode:omo-qa-local-only").toString("base64")}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path} ${response.status}: ${text.slice(0, 2000)}`)
    return text ? JSON.parse(text) : undefined
  }
}
