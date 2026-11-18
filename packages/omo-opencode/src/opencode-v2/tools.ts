import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Info, ToolContext, Result } from "@opencode/plugin/promise/tool"
import { nativePermissionAction as permissionAction } from "./legacy-permissions"
import { log } from "../shared/logger"
export { permissionAction }

export function jsonMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

export function legacyToolName(name: string): string {
  return name === "shell" ? "bash" : name === "subagent" ? "task" : name
}

export function jsonSchema(args: ToolDefinition["args"]): Record<string, unknown> {
  // V1 installs a standalone exporter on argument schemas. Calling that
  // exporter recursively from an object export corrupts Zod's reference graph.
  // Conversion is synchronous: restore every override before returning.
  const overrides = new Map<Record<string, unknown>, unknown>()
  const visited = new Set<object>()
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || visited.has(value)) return
    visited.add(value)
    const object = value as Record<string, unknown>
    const internals = object._zod as Record<string, unknown> | undefined
    if (internals?.toJSONSchema) {
      overrides.set(internals, internals.toJSONSchema)
      delete internals.toJSONSchema
    }
    for (const nested of Object.values((internals?.def as Record<string, unknown>) ?? object)) visit(nested)
  }
  visit(args)
  try {
    const schema = tool.schema.toJSONSchema(tool.schema.object(args), { io: "input" })
    const { $schema: _, ...input } = schema
    return input
  } finally {
    for (const [internals, override] of overrides) internals.toJSONSchema = override
  }
}

export function toNativeTool(name: string, definition: ToolDefinition, context: Context): Info {
  let input: Record<string, unknown>
  try {
    input = jsonSchema(definition.args)
  } catch (error) {
    throw new Error(
      `Unable to translate OMO tool ${name} schema: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  return {
    name,
    description: definition.description,
    input,
    options: { codemode: false, permission: permissionAction(name) },
    execute: async (input: unknown, execution: ToolContext): Promise<Result> => {
      if (name === "task" || name === "call_omo_agent") {
        const args = input as Record<string, unknown>
        let target = typeof args.subagent_type === "string" ? args.subagent_type : undefined
        if (!target && typeof args.session_id === "string") {
          target = (await context.session.get({ sessionID: args.session_id })).agent
        }
        if (target)
          await context.permission.assert({
            sessionID: execution.sessionID,
            agent: execution.agent,
            action: "subagent",
            resources: [target],
            source: { type: "tool", messageID: execution.messageID, id: execution.id },
          })
      }
      let metadata: Record<string, unknown> = {}
      const value = await definition.execute(
        input as never,
        {
          sessionID: execution.sessionID,
          messageID: execution.messageID,
          agent: execution.agent,
          callID: execution.id,
          directory: context.location.directory,
          worktree: context.location.project.canonical,
          abort: execution.signal,
          metadata: (update: { title?: string; metadata?: Record<string, unknown> }) => {
            metadata = jsonMetadata({
              ...metadata,
              ...update.metadata,
              ...(update.title === undefined ? {} : { title: update.title }),
            })
            void execution.progress(metadata).catch((error: unknown) => {
              log("[opencode-v2] tool progress failed", {
                tool: name,
                error: error instanceof Error ? error.message : String(error),
              })
            })
          },
          ask: async (request: {
            permission: string
            patterns: string[]
            always?: string[]
            metadata?: Record<string, unknown>
          }) => {
            // Rejections must escape; the host owns interruption and denial semantics.
            await context.permission.assert({
              sessionID: execution.sessionID,
              agent: execution.agent,
              action: permissionAction(request.permission),
              resources: request.patterns,
              save: request.always,
              metadata: request.metadata,
              source: { type: "tool", messageID: execution.messageID, id: execution.id },
            })
          },
        } as never,
      )
      if (typeof value === "string") return { content: value, metadata }
      const result = value as unknown as {
        output?: string
        content?: string
        title?: string
        metadata?: Record<string, unknown>
      }
      return {
        content: result.output ?? result.content ?? "",
        metadata: jsonMetadata({
          ...metadata,
          ...result.metadata,
          ...(result.title === undefined ? {} : { title: result.title }),
        }),
      }
    },
  }
}
