#!/usr/bin/env node
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { startProvider } from "./opencode-v2-smoke-provider.mjs"
import { api, hash, pause, realState, run, sandbox, startHost } from "./opencode-v2-smoke-isolation.mjs"

const repo = fileURLToPath(new URL("../..", import.meta.url))
const options = process.argv.slice(2)
const value = (name, fallback) => options.includes(name) ? options[options.indexOf(name) + 1] : fallback
const baseline = options.includes("--baseline")
const label = baseline ? "red" : "green"
const evidence = resolve(value("--evidence-dir", join(repo, ".omo/evidence/20261118-opencode-v2")))
const bin = value("--opencode", process.env.OPENCODE_BIN ?? "opencode")
const entry = resolve(value("--entry", join(repo, "dist/index.js")))
await mkdir(evidence, { recursive: true })
const before = realState()
const provider = await startProvider()
const box = await sandbox(provider.url)
let host
let pump
let tui
const streamAbort = new AbortController()
const events = []
const checks = []
const report = { label, version: (await run(bin, ["--version"])).stdout.trim(), sandbox: box.root, checks }
function check(name, assertion) {
  assertion()
  checks.push(name)
  process.stdout.write(`PASS ${name}\n`)
}
try {
  const localPlugin = join(box.root, "plugin")
  await mkdir(localPlugin)
  await writeFile(join(localPlugin, "package.json"), JSON.stringify({ name: "omo-opencode-v2-qa", type: "module", exports: { ".": "./index.js", ...(baseline ? {} : { "./tui": "./tui.js" }) } }))
  if (baseline) {
    // Faithful to upstream's setup: registration only, no V1 runtime invoked.
    const upstreamRef = "be84607fc6f0132f3042e287594f162fad5a6a5a"
    const source = (await run("git", ["show", `${upstreamRef}:packages/omo-opencode/src/opencode-v2/server-entry.ts`], { cwd: repo })).stdout
    await writeFile(join(evidence, "red-upstream-server-entry.ts"), source)
    report.upstreamSourceSha256 = hash(source)
    report.upstreamRef = upstreamRef
    await writeFile(join(localPlugin, "index.js"), 'export default { id: "oh-my-openagent", setup() {} }\n')
  } else {
    await writeFile(join(localPlugin, "index.js"), `export { default } from ${JSON.stringify(pathToFileURL(entry).href)}\n`)
    await writeFile(join(localPlugin, "tui.js"), `export { default } from ${JSON.stringify(pathToFileURL(join(repo, "dist/tui.js")).href)}\n`)
  }
  // The ordinary GREEN path exercises the checkout's actual package exports,
  // exactly as documented for users. A wrapper is only needed for baseline or
  // an explicitly supplied alternate bundle.
  box.config.plugins = [baseline || options.includes("--entry") ? localPlugin : repo]
  box.config.experimental = { todo: true }
  await writeFile(join(box.project, "opencode.json"), JSON.stringify(box.config))
  host = await startHost(bin, box, evidence, label)
  await writeFile(join(evidence, `${label}-host.json`), JSON.stringify({ url: host.url, sandbox: box.root, project: box.project }, null, 2))
  const request = api(host.url)
  const location = `?location[directory]=${encodeURIComponent(box.project)}`
  let plugins
  let agents
  for (let attempt = 0; attempt < 150; attempt++) {
    plugins = await request("/api/plugin" + location)
    agents = (await request("/api/agent" + location)).data
    if (plugins.data.length > 0 && agents.length > 0) break
    await pause(100)
  }
  check("host finishes plugin and agent discovery", () => { assert.ok(plugins.data.length > 0); assert.ok(agents.length > 0) })
  await writeFile(join(evidence, `${label}-plugins.json`), JSON.stringify(plugins, null, 2))
  await writeFile(join(evidence, `${label}-agents.json`), JSON.stringify(agents, null, 2))
  check("Oh My OpenAgent server plugin is active", () => assert.ok(plugins.data.some((plugin) => plugin.id === "oh-my-openagent" && plugin.state.status === "active")))
  const sisyphus = agents.find((agent) => /sisyphus/i.test(agent.id) && !/junior/.test(agent.id))
  if (baseline) {
    check("RED baseline loads without Sisyphus", () => assert.equal(sisyphus, undefined))
    report.expectedFailure = "Upstream setup loads, but does not register Sisyphus or run the original plugin runtime."
  } else {
    check("original Sisyphus prompt registered", () => { assert.ok(sisyphus); assert.ok(sisyphus.system.length > 5000) })
    report.sisyphus = { id: sisyphus.id, systemLength: sisyphus.system.length, mode: sisyphus.mode }
    pump = (async () => {
      const response = await fetch(host.url + "/api/event", { headers: { authorization: `Basic ${Buffer.from("opencode:omo-qa-local-only").toString("base64")}` }, signal: streamAbort.signal })
      assert.equal(response.status, 200)
      const reader = response.body.getReader()
      let pending = ""
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        pending += new TextDecoder().decode(value)
        let boundary
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary)
          pending = pending.slice(boundary + 2)
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
          if (data) { try { events.push(JSON.parse(data)) } catch {} }
        }
      }
    })().catch((error) => { if (!streamAbort.signal.aborted) throw error })
    async function scenario(title, text, permissions, expected) {
      const session = (await request("/api/session", { title, location: { directory: box.project }, model: { providerID: "qa", id: "qa-model" }, ...(permissions ? { permissions } : {}) })).data
      await request(`/api/session/${session.id}/prompt`, { text })
      const deadline = Date.now() + 60000
      while (Date.now() < deadline) {
        const info = (await request(`/api/session/${session.id}`)).data
        if (info.time?.idle && info.time.idle >= (info.time.busy ?? 0) && info.outcome) {
          const context = (await request(`/api/session/${session.id}/context`)).data
          if (expected && !(typeof expected === "function" ? expected(JSON.stringify(context)) : JSON.stringify(context).includes(expected))) { await pause(100); continue }
          await writeFile(join(evidence, `green-${title}.json`), JSON.stringify({ session: info, context }, null, 2))
          const tools = context.flatMap((message) => message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [])
          const results = JSON.stringify(tools.map((tool) => ({ name: tool.name, status: tool.state.status, content: tool.state.content, error: tool.state.error })))
          return { info, context, tools, results, text: JSON.stringify(context) }
        }
        await pause(100)
      }
      throw new Error(`${title} did not become idle`)
    }
    const ulw = await scenario("ultrawork", "ulw OMO_QA_ULW: return the fixture marker")
    check("default session selects Sisyphus", () => assert.ok(ulw.context.some((message) => message.type === "assistant" && /sisyphus/i.test(message.agent))))
    check("ultrawork hook reaches actual model request", () => assert.ok(provider.requests.some((request) => request.branch === "ulw" && request.ultrawork)))
    const toolNames = new Set(provider.requests.flatMap((request) => request.tools))
    check("original task, skill and background tools available", () => { for (const tool of ["task", "skill", "background_output", "background_cancel"]) assert.ok(toolNames.has(tool), tool) })
    const skill = await scenario("skill", "OMO_QA_SKILL: load the local qa-proof skill")
    check("original skill tool returns discovered skill body", () => assert.match(skill.results, /OMO_QA_SKILL_BODY/))
    const delegation = await scenario("delegation", "OMO_QA_DELEGATE: delegate to explore")
    const children = (await request(`/api/session?parentID=${encodeURIComponent(delegation.info.id)}`)).data
    check("delegation creates a real child with parentID", () => assert.ok(children.some((child) => child.parentID === delegation.info.id)))
    check("delegated response delivered to parent tool result", () => assert.match(delegation.results, /OMO_QA_CHILD_OK/))
    const background = await scenario("background", "OMO_QA_BG_PARENT: delegate in background and wait for completion", undefined, (text) => text.includes("OMO_QA_BG_PARENT_OK") && provider.requests.some((request) => {
      const latest = JSON.stringify(request.messages.filter((message) => message.role === "user").at(-1)?.content)
      return request.branch === "background" && latest.includes("[ALL BACKGROUND TASKS COMPLETE]") && !latest.includes("OMO_INTERNAL_NOREPLY")
    }))
    const backgroundChildren = (await request(`/api/session?parentID=${encodeURIComponent(background.info.id)}`)).data
    check("background delegation retains native parentID", () => assert.ok(backgroundChildren.some((child) => child.parentID === background.info.id)))
    check("background completion wakes parent and output is collected", () => { assert.match(background.results, /OMO_QA_CHILD_OK/); assert.ok(background.tools.some((tool) => tool.name === "background_output" && tool.state.status === "completed")); assert.ok(provider.requests.filter((request) => request.branch === "background").length >= 4) })
    const read = await scenario("native-read", "OMO_QA_READ: read qa-proof.txt")
    check("native read result passes original hashline after-hook", () => assert.match(read.results, /1#[A-Z0-9]+[|:][^\n]*OMO_QA_READ_LINE/))
    const denied = await scenario("permission-denial", "OMO_QA_DENY: load the local skill", [{ action: "skill", resource: "qa-proof", effect: "deny" }])
    check("explicit permission denial blocks the skill body", () => { assert.doesNotMatch(denied.results, /OMO_QA_SKILL_BODY/); assert.match(denied.results, /denied|deny|permission|rejected/i); assert.ok(denied.tools.some((tool) => tool.name === "skill" && tool.state.status === "error")) })
    const unknown = await scenario("unknown-agent", "OMO_QA_UNKNOWN: delegate to an unknown agent")
    check("unknown delegated agent gives actionable error", () => assert.match(unknown.results, /unknown|not found|invalid|available/i))
    check("SSE records actual tool and execution lifecycle", () => { for (const type of ["session.tool.called", "session.tool.success", "session.execution.succeeded"]) assert.ok(events.some((event) => event.type === type), type) })
    if (!options.includes("--skip-tui")) {
      tui = `omo-v2-qa-${process.pid}`
      const command = ["env", ...Object.entries(box.env).map(([key, val]) => `${key}=${val}`), bin, "--server", host.url, box.project]
      const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
      await run("tmux", ["new-session", "-d", "-s", tui, "-x", "120", "-y", "38", command.map(quote).join(" ")])
      let pane = ""
      for (let i = 0; i < 100; i++) { pane = (await run("tmux", ["capture-pane", "-p", "-t", tui])).stdout; if (/Ask anything|Build|Sisyphus|sisyphus/.test(pane)) break; await pause(100) }
      await run("tmux", ["send-keys", "-t", tui, "-l", "OMO_QA_COMPOSER_INPUT"])
      await pause(500)
      pane = (await run("tmux", ["capture-pane", "-p", "-t", tui])).stdout
      await writeFile(join(evidence, "green-tui-boot.txt"), pane)
      check("TUI boots and accepts composer input", () => assert.match(pane, /OMO_QA_COMPOSER_INPUT/))
    }
  }
} catch (error) {
  report.error = error.stack ?? String(error)
  process.exitCode = 1
} finally {
  if (host) {
    try {
      const request = api(host.url)
      const sessions = (await request("/api/session?limit=30")).data
      const contexts = {}
      for (const session of sessions) contexts[session.id] = (await request(`/api/session/${session.id}/context`)).data
      await writeFile(join(evidence, `${label}-sessions.json`), JSON.stringify({ sessions, contexts }, null, 2))
    } catch (error) { report.captureError = String(error) }
  }
  if (tui) await run("tmux", ["kill-session", "-t", tui]).catch(() => {})
  streamAbort.abort()
  await pump?.catch(() => {})
  await host?.stop()
  await provider.close()
  await writeFile(join(evidence, `${label}-model-requests.json`), JSON.stringify(provider.requests, null, 2))
  await writeFile(join(evidence, `${label}-events.json`), JSON.stringify(events, null, 2))
  const pluginLog = join(box.env.TMPDIR, "oh-my-opencode.log")
  if (existsSync(pluginLog)) await writeFile(join(evidence, `${label}-plugin.log`), await readFile(pluginLog))
  const after = realState()
  report.isolation = { before, after, realSessionCountUnchanged: before.sessionCount === after.sessionCount, realConfigUnchanged: JSON.stringify(before.configs) === JSON.stringify(after.configs) }
  if (!report.isolation.realSessionCountUnchanged || !report.isolation.realConfigUnchanged) { report.error ??= "Real user state changed during isolated QA"; process.exitCode = 1 }
  await box.remove()
  report.cleanup = { sandboxRemoved: !existsSync(box.root), hostExited: host?.server.exitCode !== null, providerClosed: true, tmuxRemoved: true }
  await writeFile(join(evidence, `${label}-summary.json`), JSON.stringify(report, null, 2))
  process.stdout.write(JSON.stringify(report, null, 2) + "\n")
}
