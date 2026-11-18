#!/usr/bin/env node
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("../..", import.meta.url))
const args = process.argv.slice(2)
const evidence = resolve(args.includes("--evidence-dir") ? args[args.indexOf("--evidence-dir") + 1] : join(repo, ".omo/evidence/20261118-opencode-v2"))
await mkdir(evidence, { recursive: true })
const root = await mkdtemp(join(tmpdir(), "omo-v2-lsp-qa-"))
const env = { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: join(root, "home"), TMPDIR: join(root, "tmp"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), OMO_LSP_DAEMON_DIR: join(root, "daemon") }
const project = join(root, "project")
await Promise.all([...Object.values(env).filter((value) => value?.startsWith(root)), project].map((dir) => mkdir(dir, { recursive: true })))
const cli = join(repo, "packages/lsp-daemon/dist/cli.js")
const expectedVersion = JSON.parse(await readFile(join(repo, "packages/lsp-daemon/package.json"))).version
const stamped = JSON.parse(await readFile(join(repo, "packages/lsp-daemon/dist/package.json")))
const report = { node: process.version, cli, sandbox: root, checks: [], stampedVersion: stamped.version }
let child
let stderr = ""
let daemonPID
const pending = new Map()
function check(name, condition) { assert.ok(condition, name); report.checks.push(name) }
try {
  check("daemon index bundle exists", existsSync(join(repo, "packages/lsp-daemon/dist/index.js")))
  check("original version stamp matches daemon package", stamped.version === expectedVersion && stamped.name === "@code-yeongyu/lsp-daemon")
  child = spawn(process.execPath, [cli, "mcp"], { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  let buffer = ""
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      const response = JSON.parse(line)
      const waiter = pending.get(response.id)
      if (waiter) { pending.delete(response.id); clearTimeout(waiter.timer); waiter.resolve(response) }
    }
  })
  child.on("exit", (code) => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`MCP exited ${code}: ${stderr}`)) } pending.clear() })
  let nextID = 1
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextID++
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out: ${stderr}`)) }, 25000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  })
  const initialize = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "omo-v2-build-qa", version: "1" } })
  check("Node MCP initialize succeeds", initialize.result?.serverInfo?.name === "lsp")
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
  const catalog = await request("tools/list", {})
  const expected = ["status", "diagnostics", "goto_definition", "find_references", "symbols", "prepare_rename", "rename", "format", "install_decision"]
  const names = catalog.result?.tools?.map((tool) => tool.name).sort()
  check("catalog exposes eight LSP tools plus installation decision", JSON.stringify(names) === JSON.stringify([...expected].sort()))
  const status = await request("tools/call", { name: "lsp_status", arguments: {} })
  const statusText = status.result?.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n")
  check("lsp_status alias executes through the real daemon", status.result?.isError === false && statusText?.includes("- "))
  const daemonDir = join(env.OMO_LSP_DAEMON_DIR, `v${expectedVersion}`)
  daemonPID = Number((await readFile(join(daemonDir, "daemon.pid"), "utf8")).trim())
  check("versioned daemon process and socket started in sandbox", Number.isInteger(daemonPID) && daemonPID > 0 && existsSync(join(daemonDir, "daemon.sock")))
  report.daemon = { pid: daemonPID, version: expectedVersion, directory: daemonDir }
  report.catalog = names
  report.initialize = initialize.result
  report.status = { isError: status.result.isError, text: statusText }
  const { thirdPartyRelativePaths } = await import("../../packages/shared-skills/scripts/frontend-refs-manifest.mjs")
  const references = thirdPartyRelativePaths()
  const missing = references.filter((relative) => !existsSync(join(repo, "dist/skills/frontend", relative)))
  check("focused dist contains materialized frontend references", references.length >= 148 && missing.length === 0)
  const browser = join(repo, "dist/skills/browser/runtime/omowright")
  check("focused dist contains staged browser runtime and license", ["index.js", "page-bundle.js", "manifest.json", "LICENSE"].every((name) => existsSync(join(browser, name))))
  report.assets = { frontendReferences: references.length, missing, browserVersion: JSON.parse(await readFile(join(browser, "manifest.json"))).version }
  report.result = "PASS"
} catch (error) {
  report.result = "FAIL"; report.error = error.stack ?? String(error); process.exitCode = 1
} finally {
  child?.stdin.end()
  if (child) await Promise.race([new Promise((resolve) => child.once("close", resolve)), new Promise((resolve) => setTimeout(resolve, 2000))])
  if (child?.exitCode === null) child.kill("SIGKILL")
  if (daemonPID) {
    try {
      // A unique sandbox directory owns this PID; never touch a user daemon.
      const variables = (await readFile(`/proc/${daemonPID}/environ`, "utf8")).split("\0")
      assert.ok(variables.includes(`OMO_LSP_DAEMON_DIR=${env.OMO_LSP_DAEMON_DIR}`), "daemon ownership must match sandbox")
      process.kill(daemonPID, "SIGTERM")
      for (let n = 0; n < 100 && existsSync(join(env.OMO_LSP_DAEMON_DIR, `v${expectedVersion}`, "daemon.sock")); n++) await new Promise((resolve) => setTimeout(resolve, 20))
    } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") { report.cleanupError = String(error); process.exitCode = 1 } }
  }
  report.cleanup = { proxyExited: child ? child.exitCode !== null : true, daemonSocketRemoved: !existsSync(join(env.OMO_LSP_DAEMON_DIR, `v${expectedVersion}`, "daemon.sock")) }
  await writeFile(join(evidence, "focused-lsp-stderr.log"), stderr)
  await rm(root, { recursive: true, force: true })
  report.cleanup.sandboxRemoved = !existsSync(root)
  await writeFile(join(evidence, "focused-lsp-smoke.json"), JSON.stringify(report, null, 2) + "\n")
  process.stdout.write(JSON.stringify(report, null, 2) + "\n")
}
