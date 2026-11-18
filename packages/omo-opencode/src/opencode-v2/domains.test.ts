import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import { registerDomains, seedLegacyConfig } from "./domains"
import { applyProviderConfig } from "../plugin-handlers/provider-config-handler"
import { createModelCacheState } from "../plugin-state"
import { clearVisionCapableModelsCache } from "../shared/vision-capable-models-cache"
import { getAgentDisplayName } from "../shared/agent-display-names"
import { remapAgentKeysToDisplayNames } from "../plugin-handlers/agent-key-remapper"

type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }
function fixture(
  catalog: { providers: unknown[]; models: unknown[]; agentID?: string; permissions?: Rule[] } = {
    providers: [],
    models: [],
  },
) {
  const nativeRules: Rule[] = catalog.permissions ?? [
    { action: "shell", resource: "*", effect: "allow" },
    { action: "*", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "deny" },
  ]
  const agent = {
    id: catalog.agentID ?? "custom",
    name: "Custom",
    mode: "primary",
    hidden: false,
    permissions: nativeRules,
    model: { providerID: "local", id: "model", variant: "deliberate" },
    request: { body: {}, headers: {} },
    system: "custom instructions",
  }
  const drafts = new Map<string, typeof agent>([[agent.id, structuredClone(agent)]])
  const agentTransforms: ((editor: unknown) => void)[] = []
  let baseAgents: Map<string, typeof agent> | undefined
  const sessionHooks = new Map<string, Set<() => Promise<void>>>()
  const rebuildAgents = () => {
    baseAgents ??= structuredClone(drafts)
    drafts.clear()
    for (const [id, value] of baseAgents) drafts.set(id, structuredClone(value))
    for (const transform of agentTransforms)
      transform({
        list: () => [...drafts.values()],
        get: (id: string) => drafts.get(id),
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
  }
  const nativeMcp = { type: "remote", url: "https://native.example.invalid/mcp", disabled: true }
  const mcps = new Map<string, Record<string, unknown>>([["lsp", structuredClone(nativeMcp)]])
  let defaultAgent = agent.id
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
      list: async () => ({ data: [...drafts.values()] }),
      transform: async (transform: (editor: unknown) => void) => {
        agentTransforms.push(transform)
        rebuildAgents()
        return {
          dispose: async () => {
            const index = agentTransforms.indexOf(transform)
            if (index >= 0) agentTransforms.splice(index, 1)
            rebuildAgents()
          },
        }
      },
      reload: async () => rebuildAgents(),
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
      hook: async (name: string, handler: () => Promise<void>) => {
        const handlers = sessionHooks.get(name) ?? new Set()
        sessionHooks.set(name, handlers)
        handlers.add(handler)
        return {
          dispose: async () => {
            handlers.delete(handler)
          },
        }
      },
      prompt: async (input: { text: string }) => {
        sent.push(input.text)
      },
    },
  } as unknown as Context
  return {
    context,
    nativeRules,
    nativeMcp,
    drafts,
    mcps,
    commands,
    sent,
    defaultAgent: () => defaultAgent,
    agentTransformCount: () => agentTransforms.length,
    preflight: async (name: string) => {
      for (const handler of sessionHooks.get(name) ?? []) await handler()
    },
  }
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

  test.each([undefined, "QA Captain"])(
    "keeps canonical native denies on the visible orchestrator with display override %s",
    async (displayName) => {
      const nativeRules: Rule[] = [
        { action: "skill", resource: "*", effect: "allow" },
        { action: "*", resource: "*", effect: "allow" },
        { action: "skill", resource: "qa-proof", effect: "deny" },
      ]
      const f = fixture({ providers: [], models: [], agentID: "sisyphus", permissions: nativeRules })
      const config = await seedLegacyConfig(f.context)
      const overrides = displayName ? { sisyphus: { displayName } } : undefined
      const visible = getAgentDisplayName("sisyphus", overrides)
      const remapped = remapAgentKeysToDisplayNames(
        { sisyphus: { mode: "primary", permission: { skill: "allow" } } },
        overrides,
      )
      config.agent = { ...remapped, sisyphus: { ...(remapped[visible] as Record<string, unknown>), hidden: true } }
      config.default_agent = visible
      await registerDomains(f.context, config, {}, [], [])
      const selected = f.drafts.get(f.defaultAgent())
      expect(selected?.permissions.slice(-nativeRules.length)).toEqual(nativeRules)
      expect(
        selected?.permissions.findLast(
          (rule) =>
            (rule.action === "skill" || rule.action === "*") && (rule.resource === "qa-proof" || rule.resource === "*"),
        )?.effect,
      ).toBe("deny")
    },
  )

  test("prefers an exact native visible permission definition over its canonical fallback", async () => {
    const f = fixture({
      providers: [],
      models: [],
      agentID: "sisyphus",
      permissions: [{ action: "skill", resource: "qa-proof", effect: "deny" }],
    })
    const visible = getAgentDisplayName("sisyphus")
    const exactRules: Rule[] = [{ action: "skill", resource: "qa-proof", effect: "ask" }]
    const canonical = f.drafts.get("sisyphus")
    if (!canonical) throw new Error("Fixture is missing its native canonical agent")
    f.drafts.set(visible, { ...structuredClone(canonical), id: visible, permissions: exactRules })
    const config = await seedLegacyConfig(f.context)
    const remapped = remapAgentKeysToDisplayNames({ sisyphus: { mode: "primary", permission: { skill: "allow" } } })
    config.agent = { ...remapped, sisyphus: { ...(remapped[visible] as Record<string, unknown>), hidden: true } }
    config.default_agent = visible
    await registerDomains(f.context, config, {}, [], [])
    expect(f.drafts.get(visible)?.permissions.slice(-exactRules.length)).toEqual(exactRules)
  })

  test("inherits late native config policy once before concurrent sessions and rebuilds it on reload", async () => {
    const f = fixture({ providers: [], models: [], agentID: "build", permissions: [] })
    const config = await seedLegacyConfig(f.context)
    const visible = getAgentDisplayName("sisyphus")
    const remapped = remapAgentKeysToDisplayNames({ sisyphus: { mode: "primary", permission: { skill: "allow" } } })
    config.agent = { ...remapped, sisyphus: { ...(remapped[visible] as Record<string, unknown>), hidden: true } }
    config.default_agent = visible
    const registrations: { dispose(): Promise<void> | void }[] = []
    await registerDomains(f.context, config, {}, [], registrations)
    let configuredRules: Rule[] = [{ action: "skill", resource: "qa-proof", effect: "deny" }]
    // Pinned native plugin order is OMO first, config.agent afterward. Its global
    // rules apply to all existing agents; its scoped rules apply only to the exact ID.
    const native = await f.context.agent.transform((editor) => {
      for (const agent of editor.list())
        editor.update(agent.id, (draft) => draft.permissions.push({ action: "*", resource: "*", effect: "allow" }))
      editor.update("sisyphus", (draft) => draft.permissions.push(...configuredRules))
    })
    expect(f.drafts.get(visible)?.permissions.some((rule) => rule.resource === "qa-proof")).toBe(false)
    await Promise.all([f.preflight("prompt"), f.preflight("context")])
    expect(
      f.drafts.get(visible)?.permissions.findLast((rule) => rule.action === "skill" || rule.action === "*")?.effect,
    ).toBe("deny")
    expect(f.drafts.get(visible)?.permissions.filter((rule) => rule.resource === "qa-proof")).toHaveLength(1)
    expect(f.agentTransformCount()).toBe(3)
    configuredRules = [{ action: "skill", resource: "after-reload", effect: "deny" }]
    await f.context.agent.reload()
    expect(f.drafts.get(visible)?.permissions.some((rule) => rule.resource === "qa-proof")).toBe(false)
    expect(f.drafts.get(visible)?.permissions.filter((rule) => rule.resource === "after-reload")).toHaveLength(1)
    for (const registration of registrations.reverse()) await registration.dispose()
    expect(f.agentTransformCount()).toBe(1)
    await native.dispose()
    expect(f.agentTransformCount()).toBe(0)
  })

  test("keeps a late exact native visible policy authoritative over canonical inheritance", async () => {
    const f = fixture({ providers: [], models: [], agentID: "build", permissions: [] })
    const config = await seedLegacyConfig(f.context)
    const visible = getAgentDisplayName("sisyphus")
    const remapped = remapAgentKeysToDisplayNames({ sisyphus: { mode: "primary", permission: { skill: "allow" } } })
    config.agent = { ...remapped, sisyphus: { ...(remapped[visible] as Record<string, unknown>), hidden: true } }
    await registerDomains(f.context, config, {}, [], [])
    await f.context.agent.transform((editor) => {
      for (const agent of editor.list())
        editor.update(agent.id, (draft) => draft.permissions.push({ action: "*", resource: "*", effect: "allow" }))
      editor.update("sisyphus", (draft) =>
        draft.permissions.push({ action: "skill", resource: "qa-proof", effect: "deny" }),
      )
      editor.update(visible, (draft) =>
        draft.permissions.push({ action: "skill", resource: "qa-proof", effect: "ask" }),
      )
    })
    await f.preflight("prompt")
    expect(
      f.drafts
        .get(visible)
        ?.permissions.findLast(
          (rule) =>
            (rule.action === "skill" || rule.action === "*") && (rule.resource === "qa-proof" || rule.resource === "*"),
        )?.effect,
    ).toBe("ask")
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
