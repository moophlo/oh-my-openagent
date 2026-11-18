import * as Plugin from "@opencode/plugin/promise/plugin"
import type { Hooks } from "@opencode-ai/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import { createTools } from "../create-tools"
import type { LoadedSkill } from "../features/opencode-skill-loader/types"
import { createPluginModule } from "../testing/create-plugin-module"
import { log } from "../shared/logger"
import { createLegacyClient } from "./legacy-client"
import { buildV1Input } from "./input"
import { registerDomains, seedLegacyConfig } from "./domains"
import { registerHooks } from "./hooks"
import { toNativeTool } from "./tools"
import { createEventTranslator } from "./events"

export type ServerDependencies = {
  createPluginModule: typeof createPluginModule
  createLegacyClient: typeof createLegacyClient
  createTools: typeof createTools
}
const defaults: ServerDependencies = { createPluginModule, createLegacyClient, createTools }

export async function setupOpenCodeV2(
  context: Plugin.Context,
  overrides: Partial<ServerDependencies> = {},
): Promise<Plugin.Cleanup> {
  const deps = { ...defaults, ...overrides }
  const config = await seedLegacyConfig(context)
  const legacy = deps.createLegacyClient(context, () => config)
  const registrations: Registration[] = []
  const controller = new AbortController()
  const translator = createEventTranslator()
  let hooks: (Hooks & { dispose?: () => Promise<void> }) | undefined
  let eventLoop: Promise<void> | undefined
  let disposed = false
  const cleanup = async () => {
    if (disposed) return
    disposed = true
    controller.abort()
    const failures: unknown[] = []
    // The original manager interrupts its native children during shutdown. Keep
    // the client usable until those requests have been sent, then cancel waits.
    try {
      await hooks?.dispose?.()
    } catch (error) {
      failures.push(error)
    }
    try {
      await legacy.dispose()
      await eventLoop
    } catch (error) {
      failures.push(error)
    }
    for (const registration of registrations.reverse()) {
      try {
        await registration.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    translator.clear()
    if (failures.length) throw new AggregateError(failures, "OpenCode V2 cleanup failed")
  }
  try {
    let skills: LoadedSkill[] = []
    const module = deps.createPluginModule(
      {
        createTools: async (input) => {
          const result = await deps.createTools(input)
          skills = result.mergedSkills
          return result
        },
      },
      { host: "opencode-v2" },
    )
    hooks = await module.server(buildV1Input(context, legacy.client), {})
    // This is the original complete engine/config pipeline, not a separate agent factory.
    await hooks.config?.(config as never)
    for (const skill of skills)
      if (skill.lazyContent && !skill.lazyContent.loaded) {
        skill.definition.template = await skill.lazyContent.load()
      }
    await registerDomains(context, config, hooks, skills, registrations)
    const tools = hooks.tool ?? {}
    registrations.push(
      await context.tool.transform((editor) => {
        if (tools.task) editor.remove("subagent")
        for (const [name, definition] of Object.entries(tools)) editor.add(toNativeTool(name, definition, context))
      }),
    )
    await registerHooks(context, hooks, registrations, config)
    eventLoop = (async () => {
      try {
        for await (const event of context.event.subscribe({ signal: controller.signal })) {
          try {
            legacy.observe(event)
            for (const translated of translator.translate(event)) await hooks?.event?.({ event: translated } as never)
          } catch (error) {
            // One malformed notification or failed hook must not disconnect all
            // background completion, cleanup and continuation delivery.
            log("[opencode-v2] event dispatch failed", {
              type: event.type,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      } catch (error) {
        if (!controller.signal.aborted)
          log("[opencode-v2] event bridge failed", {
            error: error instanceof Error ? error.message : String(error),
          })
      }
    })()
    log("[opencode-v2] original engine ready", {
      agents: Object.keys(config.agent ?? {}),
      tools: Object.keys(tools),
      registrations: registrations.length,
    })
    return cleanup
  } catch (error) {
    try {
      await cleanup()
    } catch (cleanupError) {
      log("[opencode-v2] failed setup cleanup", { error: String(cleanupError) })
    }
    throw error
  }
}

export const opencodeV2Server = Plugin.define({ id: "oh-my-openagent", setup: setupOpenCodeV2 })
