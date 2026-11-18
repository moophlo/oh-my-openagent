#!/usr/bin/env bun
import { cp, mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Build the local OpenCode plugin without the unrelated native/Desktop/Codex apps.
const root = fileURLToPath(new URL("..", import.meta.url))
async function run(command: string, args: string[]) {
  const child = Bun.spawn([command, ...args], { cwd: root, stdout: "inherit", stderr: "inherit" })
  if (await child.exited !== 0) throw new Error(`OpenCode V2 build prerequisite failed: ${command} ${args.join(" ")}`)
}
async function bundle(entrypoints: string[], outdir: string, target: "bun" | "node") {
  const result = await Bun.build({
    entrypoints: entrypoints.map((entry) => resolve(root, entry)),
    outdir: resolve(root, outdir),
    target,
    format: "esm",
    external: ["zod", "@opencode/*", "@opentui/*"],
  })
  if (!result.success) throw new AggregateError(result.logs, `Could not build ${entrypoints.join(", ")}`)
  process.stdout.write(`Built ${entrypoints.join(", ")}\n`)
}

await bundle(["packages/omo-opencode/src/index.ts", "packages/omo-opencode/src/tui.ts"], "dist", "bun")
await bundle([
  "packages/lsp-tools-mcp/src/cli.ts",
  "packages/lsp-tools-mcp/src/mcp.ts",
  "packages/lsp-tools-mcp/src/tools.ts",
  "packages/lsp-tools-mcp/src/request-context.ts",
  "packages/lsp-tools-mcp/src/lsp/manager.ts",
], "packages/lsp-tools-mcp/dist", "node")
await bundle(["packages/lsp-daemon/src/cli.ts", "packages/lsp-daemon/src/index.ts", "packages/lsp-daemon/src/client.ts"], "packages/lsp-daemon/dist", "node")
await run("node", ["packages/lsp-daemon/scripts/stamp-dist-version.mjs", resolve(root, "packages/lsp-daemon/dist")])
// Includes pinned frontend submodules and the self-contained browser runtime.
await run(process.execPath, ["run", "build:materialize-frontend"])
await mkdir(resolve(root, "dist"), { recursive: true })
await cp(resolve(root, "packages/shared-skills/skills"), resolve(root, "dist/skills"), { recursive: true })
process.stdout.write("OpenCode V2 local plugin build complete.\n")
