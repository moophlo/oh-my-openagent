import type { Context } from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { Hooks } from "@opencode-ai/plugin"
import type { LoadedSkill } from "../features/opencode-skill-loader/types"
import { permissionAction } from "./tools"
import { toLegacyModel } from "./legacy-models"
import { getAgentConfigKey } from "../shared/agent-display-names"

export type LegacyConfig = Record<string, unknown>
const nativeCommands = new WeakMap<LegacyConfig, ReadonlySet<string>>()
type NativePermissionSnapshot = {
  exact: ReadonlyMap<string, ReturnType<typeof permissions>>
  canonical: ReadonlyMap<string, ReturnType<typeof permissions>>
}
const nativePermissions = new WeakMap<LegacyConfig, NativePermissionSnapshot>()
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
export function entries(value: unknown): [string, Record<string, unknown>][] {
  return Object.entries(record(value)).map(([key, entry]) => [key, record(entry)])
}
export function modelRef(value: unknown): { providerID: string; id: string; variant?: string } | undefined {
  if (typeof value !== "string" || !value.includes("/")) return undefined
  const split = value.indexOf("/")
  const [id, variant] = value.slice(split + 1).split("#", 2)
  return { providerID: value.slice(0, split), id, ...(variant ? { variant } : {}) }
}
export function permissions(
  ...values: unknown[]
): { action: string; resource: string; effect: "allow" | "ask" | "deny" }[] {
  const rules: ReturnType<typeof permissions> = []
  for (const value of values)
    for (const [action, effect] of Object.entries(record(value))) {
      const mapped = permissionAction(action)
      if (effect === "allow" || effect === "ask" || effect === "deny")
        rules.push({ action: mapped, resource: "*", effect })
      else
        for (const [resource, nested] of Object.entries(record(effect))) {
          if (nested === "allow" || nested === "ask" || nested === "deny")
            rules.push({ action: mapped, resource, effect: nested })
        }
    }
  return rules
}
function rows<T>(value: { data: T[] } | T[]): T[] {
  return Array.isArray(value) ? value : value.data
}

/** Snapshot domain APIs before transforms are installed, avoiding recursive inventory resolution. */
export async function seedLegacyConfig(context: Context): Promise<LegacyConfig> {
  const [agents, providers, models, selected, commands] = await Promise.all([
    context.agent.list(),
    context.provider.list(),
    context.model.list(),
    context.model.default(),
    context.command.list(),
  ])
  const inventory = rows(models)
  const nativeDefault = selected && "data" in selected ? selected.data : selected
  const model = record(nativeDefault)
  const defaultAgent = rows(agents)[0]?.id
  const config: LegacyConfig = {
    ...(defaultAgent && defaultAgent !== "build" ? { default_agent: defaultAgent } : {}),
    ...(typeof model.providerID === "string" && typeof model.id === "string"
      ? { model: `${model.providerID}/${model.id}` }
      : {}),
    agent: Object.fromEntries(
      rows(agents).map((agent) => [
        agent.id,
        {
          description: agent.description,
          mode: agent.mode,
          hidden: agent.hidden,
          prompt: agent.system,
          model: agent.model
            ? `${agent.model.providerID}/${agent.model.id}${agent.model.variant ? `#${agent.model.variant}` : ""}`
            : undefined,
          temperature: agent.request.body.temperature,
          // Native rules are an ordered list, including interleaved wildcard actions.
          // Keep them in the native draft; a V1 object cannot represent their order.
        },
      ]),
    ),
    provider: Object.fromEntries(
      rows(providers).map((provider) => [
        provider.id,
        {
          name: provider.name,
          npm: provider.package,
          options: provider.settings,
          models: Object.fromEntries(
            inventory
              .filter((item) => item.providerID === provider.id)
              .map((item) => [item.id, toLegacyModel(item, provider)]),
          ),
        },
      ]),
    ),
  }
  nativeCommands.set(config, new Set(rows(commands).map((command) => command.name)))
  const exact = new Map(rows(agents).map((agent) => [agent.id, agent.permissions.map((rule) => ({ ...rule }))]))
  const canonical = new Map<string, ReturnType<typeof permissions>>()
  for (const [id, rules] of exact) {
    const key = getAgentConfigKey(id)
    if (!canonical.has(key) || id === key) canonical.set(key, rules)
  }
  nativePermissions.set(config, { exact, canonical })
  return config
}

export async function registerDomains(
  context: Context,
  config: LegacyConfig,
  hooks: Hooks,
  skills: LoadedSkill[],
  registrations: Registration[],
): Promise<void> {
  const snapshot = nativePermissions.get(config)
  const beforeNativeConfig = new Map<string, ReturnType<typeof permissions>>()
  // The original config hook copies the visible entry (including its name) to a
  // hidden canonical alias. That existing relationship also covers displayName
  // overrides unknown to the fixed display-name registry.
  const displayAliases = new Map<string, string>()
  for (const [id, source] of entries(config.agent)) {
    if (source.hidden === true && typeof source.name === "string" && source.name !== id) {
      displayAliases.set(source.name, getAgentConfigKey(id))
    }
  }
  registrations.push(
    await context.agent.transform((editor) => {
      beforeNativeConfig.clear()
      for (const [id, source] of entries(config.agent)) {
        if (source.disable === true) {
          editor.remove(id)
          continue
        }
        editor.update(id, (draft) => {
          const target = draft as unknown as Record<string, unknown>
          for (const key of ["description", "mode", "hidden", "color"])
            if (source[key] !== undefined) target[key] = source[key]
          if (source.prompt !== undefined) target.system = source.prompt
          if (source.maxSteps !== undefined || source.steps !== undefined)
            target.steps = source.maxSteps ?? source.steps
          const model = modelRef(source.model)
          if (model)
            target.model = { ...model, ...(typeof source.variant === "string" ? { variant: source.variant } : {}) }
          const toolRules = Object.fromEntries(
            Object.entries(record(source.tools)).map(([name, enabled]) => [name, enabled ? "allow" : "deny"]),
          )
          const globalToolRules = Object.fromEntries(
            Object.entries(record(config.tools)).map(([name, enabled]) => [name, enabled ? "allow" : "deny"]),
          )
          target.permissions = [
            ...permissions(globalToolRules, config.permission, toolRules, source.permission),
            ...(snapshot?.exact.get(id) ??
              snapshot?.canonical.get(displayAliases.get(id) ?? getAgentConfigKey(id)) ??
              draft.permissions),
          ]
          beforeNativeConfig.set(
            id,
            draft.permissions.map((rule) => ({ ...rule })),
          )
          draft.request.body = { ...draft.request.body, ...record(source.options) }
          for (const [from, to] of [
            ["temperature", "temperature"],
            ["top_p", "topP"],
            ["top_k", "topK"],
            ["maxTokens", "maxTokens"],
          ]) {
            if (source[from] !== undefined) draft.request.body[to] = source[from]
          }
        })
      }
      if (typeof config.default_agent === "string") editor.default(config.default_agent)
    }),
  )
  // Native config.agent is registered after external plugins in 2.3.2. The
  // first session preflight runs after host initialization and installs this
  // final transform after those native policies, without a timer or a second
  // event stream. Permission.assert resolves the live Agent state at each call.
  const sameRule = (left: ReturnType<typeof permissions>[number], right: ReturnType<typeof permissions>[number]) =>
    left.action === right.action && left.resource === right.resource && left.effect === right.effect
  const addedRules = (id: string, current: ReturnType<typeof permissions>) => {
    const before = beforeNativeConfig.get(id) ?? []
    if (current.length < before.length || before.some((rule, index) => !sameRule(rule, current[index]))) {
      throw new Error(`Native agent policy replaced OMO's prefix for ${id}`)
    }
    return current.slice(before.length)
  }
  let disposed = false
  let tail: Promise<Registration> | undefined
  const ensureNativeAliasPolicy = async () => {
    if (disposed) throw new Error("OpenCode V2 alias policy is disposed")
    tail ??= context.agent.transform((editor) => {
      for (const [id] of entries(config.agent)) {
        const canonical = displayAliases.get(id) ?? getAgentConfigKey(id)
        if (canonical === id) continue
        const native = editor.get(canonical)
        const target = editor.get(id)
        if (!native || !target) continue
        const inherited = addedRules(canonical, native.permissions)
        const exact = addedRules(id, target.permissions)
        // Native config appends global rules to both entries before exact-ID
        // rules. Replay that shared prefix once, then keep an exact visible
        // definition last so it retains the native precedence over fallback.
        let shared = 0
        while (shared < inherited.length && shared < exact.length && sameRule(inherited[shared], exact[shared]))
          shared++
        target.permissions = [...(beforeNativeConfig.get(id) ?? []), ...inherited, ...exact.slice(shared)]
      }
    })
    await tail
  }
  registrations.push(await context.session.hook("prompt", ensureNativeAliasPolicy))
  registrations.push(await context.session.hook("context", ensureNativeAliasPolicy))
  registrations.push({
    dispose: async () => {
      disposed = true
      if (tail) await (await tail).dispose()
      beforeNativeConfig.clear()
    },
  })
  registrations.push(
    await context.provider.transform((editor) => {
      for (const [id, source] of entries(config.provider)) {
        const packageName = String(source.npm ?? "")
        const nativePackage = packageName.startsWith("@ai-sdk/") ? `aisdk:${packageName}` : packageName
        if (!editor.get(id)) {
          editor.add({
            info: {
              id,
              name: String(source.name ?? id),
              package: nativePackage,
              activation: "auto",
              settings: record(source.options),
            } as never,
            models: [],
          })
        } else
          editor.update(id, (provider) => {
            if (typeof source.name === "string") provider.name = source.name
            if (typeof source.npm === "string") provider.package = nativePackage
            provider.settings = { ...provider.settings, ...record(source.options) }
          })
        for (const [modelID, sourceModel] of entries(source.models)) {
          const existing = editor.get(id)?.models.get(modelID)
          if (!existing) {
            // Legacy providers must supply their catalog's real limits. An absent
            // catalog entry cannot safely advertise invented image/context support.
            const limits = record(sourceModel.limit)
            if (typeof limits.context !== "number" || typeof limits.output !== "number") continue
            const modalities = record(sourceModel.modalities)
            const info = {
              id: modelID,
              modelID,
              providerID: id,
              name: String(sourceModel.name ?? modelID),
              capabilities: {
                tools: sourceModel.tool_call === true,
                input: modalities.input ?? ["text"],
                output: modalities.output ?? ["text"],
              },
              variants: [],
              time: { released: 0 },
              cost: [],
              status: "active",
              enabled: true,
              limit: limits,
              settings: record(sourceModel.options),
            }
            editor.models.set(id, [...(editor.get(id)?.models.values() ?? []), info as never])
          } else
            editor.models.update(id, modelID, (model) => {
              model.settings = { ...model.settings, ...record(sourceModel.options) }
            })
        }
      }
    }),
  )
  registrations.push(
    await context.mcp.transform((editor) => {
      for (const [name, source] of entries(config.mcp)) {
        // The original V1 merge gives configured host MCPs precedence over builtins.
        // The native list API exposes status only, so preserve the editor's declaration.
        if (editor.get(name) !== undefined) continue
        const { enabled, timeout, ...rest } = source
        editor.set(name, {
          ...rest,
          ...(enabled === undefined ? {} : { disabled: !enabled }),
          ...(typeof timeout === "number" ? { timeout: { execution: timeout } } : timeout ? { timeout } : {}),
        } as never)
      }
    }),
  )
  registrations.push(
    await context.skill.transform((editor) => {
      for (const skill of skills) {
        editor.add({
          id: skill.name,
          name: skill.name,
          path: skill.path ?? context.location.directory,
          description: skill.definition.description,
          content: skill.definition.template,
        } as never)
      }
    }),
  )
  registrations.push(
    await context.command.transform((editor) => {
      for (const [name, command] of entries(config.command)) {
        // CommandInfo has no source/template field in 2.3.2. Preserve every native
        // collision instead of guessing whether it came from a user or a builtin.
        if (nativeCommands.get(config)?.has(name)) continue
        editor.add({
          name,
          description: typeof command.description === "string" ? command.description : undefined,
          execute: async ({ sessionID, prompt, delivery }) => {
            const text = String(command.template ?? "").replace(
              /\$ARGUMENTS|\$(\d+)/g,
              (_placeholder, index: string | undefined) =>
                index === undefined ? prompt.text : (prompt.text.trim().split(/\s+/)[Number(index) - 1] ?? ""),
            )
            const output = { parts: [{ type: "text", text }] }
            await hooks["command.execute.before"]?.(
              { command: name, sessionID, arguments: prompt.text } as never,
              output as never,
            )
            if (typeof command.agent === "string")
              await context.session.switchAgent({ sessionID, agent: command.agent })
            const selected = modelRef(command.model)
            if (selected) await context.session.switchModel({ sessionID, model: selected })
            await context.session.prompt({
              sessionID,
              text: output.parts
                .map((part) => part.text)
                .filter(Boolean)
                .join("\n\n"),
              files: prompt.files,
              agents: prompt.agents,
              delivery,
            })
          },
        })
      }
    }),
  )
}
