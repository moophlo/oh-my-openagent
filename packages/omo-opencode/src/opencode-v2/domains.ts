import type { Context } from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { Hooks } from "@opencode-ai/plugin"
import type { LoadedSkill } from "../features/opencode-skill-loader/types"
import { permissionAction } from "./tools"
import { toLegacyModel } from "./legacy-models"

export type LegacyConfig = Record<string, unknown>
const nativeCommands = new WeakMap<LegacyConfig, ReadonlySet<string>>()
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
  return config
}

export async function registerDomains(
  context: Context,
  config: LegacyConfig,
  hooks: Hooks,
  skills: LoadedSkill[],
  registrations: Registration[],
): Promise<void> {
  registrations.push(
    await context.agent.transform((editor) => {
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
            ...draft.permissions,
          ]
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
