import type { Hooks } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { Result } from "@opencode/plugin/promise/tool"
import { modelRef, record, type LegacyConfig } from "./domains"
import { messageView, systemView, type LegacyMessage, type NativeMessage } from "./messages"
import { jsonMetadata, legacyToolName, permissionAction } from "./tools"

function legacyArguments(tool: string, value: unknown): Record<string, unknown> {
  const args = { ...record(value) }
  if (["read", "write", "edit"].includes(tool) && typeof args.path === "string") {
    args.filePath = args.path
    delete args.path
  }
  return args
}
function nativeArguments(tool: string, value: Record<string, unknown>): Record<string, unknown> {
  const args = { ...value }
  if (["read", "write", "edit"].includes(tool) && typeof args.filePath === "string") {
    args.path = args.filePath
    delete args.filePath
  }
  return args
}

function readOutputView(tool: string, text: string): { output: string; restore: (output: string) => string } {
  // V2 adds a human-readable header before numbered file lines. The original
  // enhancer understands V1 content blocks; unwrap the adapter's block after
  // the hooks so unchanged reads retain their exact native representation.
  const header = tool === "read" ? /^(Read file [^\n]+\n)(?=\s*\d+[:|])/.exec(text)?.[1] : undefined
  if (!header) return { output: text, restore: (output) => output }
  const output = `${header}<content>\n${text.slice(header.length)}\n</content>`
  return {
    output,
    restore: (updated) =>
      updated === output ? text : updated.replace(`${header}<content>\n`, header).replace("\n</content>", ""),
  }
}

export async function registerHooks(
  context: Context,
  hooks: Hooks,
  registrations: Registration[],
  config: LegacyConfig = {},
): Promise<void> {
  const variants = new Map<string, string>()
  const compacted = new Set<string>()
  registrations.push(
    await context.session.hook("experimental.model.resolve", (event) => {
      const variant = variants.get(event.sessionID)
      if (variant) event.model = { ...event.model, variant } as typeof event.model
    }),
  )
  registrations.push(
    await context.session.hook("prompt", async (event) => {
      const session = await context.session.get({ sessionID: event.sessionID })
      const selected = record(session)
      const model = selected.model ? record(selected.model) : record(modelRef(config.model))
      const beforeAgent =
        typeof selected.agent === "string"
          ? selected.agent
          : typeof config.default_agent === "string"
            ? config.default_agent
            : undefined
      const message: Record<string, unknown> = {
        id: event.messageID,
        sessionID: event.sessionID,
        role: "user",
        agent: beforeAgent,
        model: { providerID: model.providerID, modelID: model.id },
      }
      const original = record(record(event.metadata).omoV1)
      const originalParts = Array.isArray(original.parts) ? original.parts.map((part) => ({ ...record(part) })) : []
      const texts = originalParts.filter((part) => part.type === "text")
      const unchanged = texts.map((part) => String(part.text ?? "")).join("\n\n") === event.prompt.text
      // Automated continuations can be marker-less and rely on per-part flags.
      // Retain those flags while treating the native host's current text as authoritative.
      const parts =
        originalParts.length && unchanged
          ? originalParts
          : [{ ...(texts.length === 1 ? texts[0] : {}), type: "text", text: event.prompt.text }]
      const output = { message, parts }
      await hooks["chat.message"]?.(
        {
          sessionID: event.sessionID,
          agent: beforeAgent,
          model: typeof model.id === "string" ? { providerID: model.providerID, modelID: model.id } : undefined,
        } as never,
        output as never,
      )
      event.prompt.text = output.parts
        .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n\n")
      event.metadata = {
        ...event.metadata,
        omoV1Message: JSON.parse(JSON.stringify(message)) as Record<string, unknown>,
        omoV1: jsonMetadata({ ...original, parts: output.parts }),
      }
      if (typeof message.variant === "string") variants.set(event.sessionID, message.variant)
      if (typeof message.agent === "string" && message.agent !== beforeAgent)
        await context.session.switchAgent({ sessionID: event.sessionID, agent: message.agent })
      const updatedModel = record(message.model)
      if (
        typeof updatedModel.modelID === "string" &&
        typeof updatedModel.providerID === "string" &&
        (updatedModel.modelID !== model.id || updatedModel.providerID !== model.providerID)
      ) {
        await context.session.switchModel({
          sessionID: event.sessionID,
          model: { providerID: updatedModel.providerID, id: updatedModel.modelID },
        })
      }
    }),
  )
  registrations.push(
    await context.session.hook("context", async (event) => {
      const latestUser = [...event.messages].reverse().find((message) => message.role === "user")
      const metadata = record(record(latestUser?.metadata).omoV1)
      if (typeof metadata?.system === "string" && !event.system.some((part) => part.text === metadata.system))
        event.system.push({ type: "text", text: metadata.system })
      for (const [name, enabled] of Object.entries(record(metadata?.tools)))
        if (enabled === false) {
          delete event.tools[name]
          delete event.tools[permissionAction(name)]
        }
      for (const [toolID, tool] of Object.entries(event.tools)) {
        const output = { description: tool.description, parameters: tool.input }
        await hooks["tool.definition"]?.({ toolID: legacyToolName(toolID) } as never, output as never)
        tool.description = output.description
        tool.input = output.parameters
      }
      const options = { ...event.options }
      for (const key of ["temperature", "topP", "topK", "maxTokens"]) delete options[key]
      const params = {
        temperature: typeof event.options.temperature === "number" ? event.options.temperature : undefined,
        topP: typeof event.options.topP === "number" ? event.options.topP : undefined,
        topK: typeof event.options.topK === "number" ? event.options.topK : undefined,
        maxOutputTokens: typeof event.options.maxTokens === "number" ? event.options.maxTokens : undefined,
        options,
      }
      const nativeModel = record(record(record(record(config.provider)[event.model.providerID]).models)[event.model.id])
      const message = { variant: variants.get(event.sessionID) ?? event.model.variant }
      await hooks["chat.params"]?.(
        {
          sessionID: event.sessionID,
          agent: { name: event.agent },
          model: { ...nativeModel, ...event.model, modelID: event.model.id },
          provider: { id: event.model.providerID },
          message,
        } as never,
        params as never,
      )
      if (message.variant) variants.set(event.sessionID, message.variant)
      else variants.delete(event.sessionID)
      event.options = { ...params.options }
      for (const [from, to] of [
        ["temperature", "temperature"],
        ["topP", "topP"],
        ["topK", "topK"],
        ["maxOutputTokens", "maxTokens"],
      ] as const) {
        if (params[from] === undefined) delete event.options[to]
        else event.options[to] = params[from]
      }
      const system = systemView(event.system as unknown as Record<string, unknown>[])
      const output = { system: system.system }
      await hooks["experimental.chat.system.transform"]?.(
        { sessionID: event.sessionID, model: event.model } as never,
        output,
      )
      event.system = system.apply(output.system) as typeof event.system
      const messages = messageView(
        event.sessionID,
        event.messages as unknown as NativeMessage[],
        event.agent,
        event.model,
      )
      const transformed = { messages: messages.messages }
      await hooks["experimental.chat.messages.transform"]?.({} as never, transformed as never)
      event.messages = messages.apply(transformed.messages as LegacyMessage[]) as unknown as typeof event.messages
    }),
  )
  registrations.push(
    await context.session.hook("model.request", async (event) => {
      const output = { headers: { ...event.headers } }
      await hooks["chat.headers"]?.(
        {
          sessionID: event.sessionID,
          agent: { name: event.agent },
          model: event.model,
          provider: { id: event.model.providerID },
          message: {},
        } as never,
        output,
      )
      event.headers = output.headers
    }),
  )
  registrations.push(
    await context.tool.hook("execute.before", async (event) => {
      const original = legacyToolName(event.tool)
      const input = {
        tool: original,
        sessionID: event.sessionID,
        callID: event.id,
        messageID: event.messageID,
        agent: event.agent,
      }
      const output = { args: legacyArguments(original, event.input) }
      await hooks["tool.execute.before"]?.(input, output)
      event.input = nativeArguments(original, output.args)
      if (input.tool !== original) event.tool = input.tool === "bash" ? "shell" : input.tool
    }),
  )
  registrations.push(
    await context.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return
      const content = event.result.content
      const text =
        typeof content === "string"
          ? content
          : (content
              ?.filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n") ?? "")
      const tool = legacyToolName(event.tool)
      const args = legacyArguments(tool, event.input)
      const view = readOutputView(tool, text)
      const output = {
        title: String(event.result.metadata?.title ?? ""),
        output: view.output,
        metadata: {
          ...event.result.metadata,
          ...(["read", "write", "edit"].includes(tool) && typeof args.filePath === "string"
            ? { filePath: resolve(context.location.directory, args.filePath) }
            : {}),
        },
      }
      await hooks["tool.execute.after"]?.({ tool, sessionID: event.sessionID, callID: event.id, args }, output)
      const transformed = view.restore(output.output)
      const firstText = typeof content === "string" ? -1 : (content?.findIndex((part) => part.type === "text") ?? -1)
      event.result = {
        ...event.result,
        content:
          transformed === text
            ? content
            : typeof content === "string" || content === undefined
              ? transformed
              : firstText === -1
                ? [...content, { type: "text", text: transformed }]
                : content.flatMap<Exclude<NonNullable<Result["content"]>, string>[number]>((part, index) =>
                    part.type !== "text" ? [part] : index === firstText ? [{ ...part, text: transformed }] : [],
                  ),
        metadata: jsonMetadata({ ...output.metadata, title: output.title }),
      }
    }),
  )
  registrations.push(
    await context.session.hook("compaction", async (event) => {
      const output: { context: string[]; prompt?: string } = { context: [] }
      await hooks["experimental.session.compacting"]?.({ sessionID: event.sessionID } as never, output)
      for (const text of [...output.context, ...(output.prompt ? [output.prompt] : [])])
        if (text && !event.system.some((part) => part.text === text)) event.system.push({ type: "text", text })
      compacted.add(event.sessionID)
    }),
  )
  registrations.push(
    await context.session.hook("experimental.idle", async (event) => {
      if (!compacted.delete(event.sessionID)) return
      const selected = await context.session.get({ sessionID: event.sessionID })
      // Restore captured state once. The V2 host already resumes auto compaction itself.
      await hooks["experimental.compaction.autocontinue"]?.(
        { sessionID: event.sessionID, agent: selected.agent } as never,
        { enabled: true },
      )
    }),
  )
  registrations.push({
    dispose: async () => {
      variants.clear()
      compacted.clear()
    },
  })
}
