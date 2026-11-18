import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import { registerDomains, seedLegacyConfig } from "./domains"
import { applyProviderConfig } from "../plugin-handlers/provider-config-handler"
import { createModelCacheState } from "../plugin-state"
import { clearVisionCapableModelsCache } from "../shared/vision-capable-models-cache"

type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }
function fixture(catalog: { providers: unknown[]; models: unknown[] } = { providers: [], models: [] }) {
  const nativeRules: Rule[] = [
    { action: "shell", resource: "*", effect: "allow" },
    { action: "*", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "deny" },
  ]
  const agent = {
    id: "custom",
    name: "Custom",
    mode: "primary",
    hidden: false,
    permissions: nativeRules,
    model: { providerID: "local", id: "model", variant: "deliberate" },
    request: { body: {}, headers: {} },
    system: "custom instructions",
  }
  const drafts = new Map<string, typeof agent>([["custom", structuredClone(agent)]])
  const nativeMcp = { type: "remote", url: "https://native.example.invalid/mcp", disabled: true }
  const mcps = new Map<string, Record<string, unknown>>([["lsp", structuredClone(nativeMcp)]])
  let defaultAgent = "custom"
  const sent: string[] = []
  const commands = new Map<string, { name: string; execute(input: unknown): Promise<void> }>([
    [
      "ulw-loop",
      {
        name: "ulw-loop",
        execute: async () => {
          sent.push("native command")
        },
      },
    ],
  ])
  const registration = { dispose: async () => {} }
  const context = {
    location: { directory: "/project" },
    agent: {
      list: async () => ({ data: [agent] }),
      transform: async (transform: (editor: unknown) => void) => {
        transform({
          update: (id: string, update: (draft: typeof agent) => void) => {
            const draft = drafts.get(id) ?? { ...structuredClone(agent), id, permissions: [] }
            update(draft)
            drafts.set(id, draft)
          },
          remove: (id: string) => {
            drafts.delete(id)
          },
          default: (id: string) => {
            defaultAgent = id
          },
        })
        return registration
      },
    },
    provider: { list: async () => ({ data: catalog.providers }), transform: async () => registration },
    model: { list: async () => ({ data: catalog.models }), default: async () => ({ data: null }) },
    mcp: {
      transform: async (transform: (editor: unknown) => void) => {
        transform({
          get: (id: string) => mcps.get(id),
          set: (id: string, config: Record<string, unknown>) => mcps.set(id, config),
        })
        return registration
      },
    },
    skill: { transform: async () => registration },
    command: {
      list: async () => ({ data: [...commands.keys()].map((name) => ({ name })) }),
      transform: async (transform: (editor: unknown) => void) => {
        transform({
          add: (definition: { name: string; execute(input: unknown): Promise<void> }) =>
            commands.set(definition.name, definition),
        })
        return registration
      },
    },
    session: {
      prompt: async (input: { text: string }) => {
        sent.push(input.text)
      },
    },
  } as unknown as Context
  return { context, nativeRules, nativeMcp, drafts, mcps, commands, sent, defaultAgent: () => defaultAgent }
}

// The native editors are the public protocol boundary. V1 merge tests cannot observe
// a native user MCP/command being replaced, or an ordered native permission losing authority.
describe("native configuration preservation", () => {
  test("retains native lsp configuration and dispatches an existing native slash command", async () => {
    const f = fixture()
    const config = await seedLegacyConfig(f.context)
    config.mcp = { lsp: { type: "local", command: ["generated-lsp"] }, extra: { type: "local", command: ["extra"] } }
    config.command = { "ulw-loop": { template: "generated collision" }, fresh: { template: "new command" } }
    await registerDomains(f.context, config, {}, [], [])
    expect(f.mcps.get("lsp")).toEqual(f.nativeMcp)
    expect(f.mcps.has("extra")).toBe(true)
    await f.commands.get("ulw-loop")?.execute({ sessionID: "s", prompt: { text: "argument" }, delivery: "queue" })
    await f.commands.get("fresh")?.execute({ sessionID: "s", prompt: { text: "" }, delivery: "queue" })
    expect(f.sent).toEqual(["native command", "new command"])
  })

  test("expands generated command placeholders once without rewriting literal argument dollars", async () => {
    const f = fixture()
    const config = await seedLegacyConfig(f.context)
    config.command = { fresh: { template: "$ARGUMENTS" } }
    await registerDomains(f.context, config, {}, [], [])
    await f.commands.get("fresh")?.execute({ sessionID: "s", prompt: { text: "echo $1 $&" }, delivery: "queue" })
    expect(f.sent).toEqual(["echo $1 $&"])
  })

  test("keeps interleaved native wildcard rules ordered after generated rules", async () => {
    const f = fixture()
    const config = await seedLegacyConfig(f.context)
    config.permission = { bash: "allow" }
    await registerDomains(f.context, config, {}, [], [])
    const rules = f.drafts.get("custom")?.permissions ?? []
    expect(rules.slice(-f.nativeRules.length)).toEqual(f.nativeRules)
    // Every resource is '*' here. The native ruleset's last matching action wins:
    // regrouping shell rules around the interleaved '*' allow must never lift the deny.
    expect(rules.findLast((rule) => rule.action === "shell" || rule.action === "*")?.effect).toBe("deny")
  })

  test("feeds native vision models into the original provider capability cache", async () => {
    const f = fixture({
      providers: [{ id: "local", name: "Local", package: "aisdk:@ai-sdk/openai", activation: "auto" }],
      models: [
        {
          id: "vision",
          modelID: "vendor/vision",
          providerID: "local",
          capabilities: { tools: true, input: ["text", "image"], output: ["text"], temperature: false },
          limit: { context: 123456, output: 8192 },
          variants: [{ id: "careful", body: { reasoningEffort: "high" } }],
        },
      ],
    })
    const config = await seedLegacyConfig(f.context)
    const cache = createModelCacheState()
    try {
      applyProviderConfig({ config, modelCacheState: cache })
      expect([...(cache.visionCapableModelsCache?.keys() ?? [])]).toEqual(["local/vision"])
      expect(cache.modelContextLimitsCache.get("local/vision")).toBe(123456)
    } finally {
      clearVisionCapableModelsCache()
    }
  })

  test("retains a custom selected default and native model variant", async () => {
    const f = fixture()
    const config = await seedLegacyConfig(f.context)
    expect(config.default_agent).toBe("custom")
    ;(config.agent as Record<string, Record<string, unknown>>).custom.maxTokens = 4321
    await registerDomains(f.context, config, {}, [], [])
    expect(f.defaultAgent()).toBe("custom")
    expect(f.drafts.get("custom")?.model.variant).toBe("deliberate")
    expect((f.drafts.get("custom")?.request.body as Record<string, unknown>).maxTokens).toBe(4321)
  })
})
