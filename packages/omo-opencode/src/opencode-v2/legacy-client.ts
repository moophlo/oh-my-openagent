import type { Plugin } from "@opencode-ai/plugin"
import type { JsonValue, SessionCreateInput, SessionPromptInput } from "@opencode/client"
import type { Context } from "@opencode/plugin/promise/plugin"
import { log } from "../shared/logger"
import { record, string, toLegacyMessage, toLegacyMessages } from "./legacy-messages"
import { nativePermissionAction, legacyPermissionAction } from "./legacy-permissions"
import { toLegacyModel } from "./legacy-models"

type PluginInput = Parameters<Plugin>[0]
type Permission = NonNullable<SessionCreateInput["permissions"]>[number]

function requiredString(value: unknown, name: string): string {
  const result = string(value)
  if (!result) throw new Error(`${name} is required`)
  return result
}

function sessionID(input: unknown): string {
  const options = record(input)
  return requiredString(record(options.path).id ?? options.sessionID, "sessionID")
}

function modelOf(value: unknown): NonNullable<SessionCreateInput["model"]> | undefined {
  if (value === undefined) return undefined
  const model = record(value)
  return {
    id: requiredString(model.modelID ?? model.id, "model.id"),
    providerID: requiredString(model.providerID, "model.providerID"),
    ...(typeof model.variant === "string" ? { variant: model.variant } : {}),
  }
}

function permissionsOf(value: unknown): Permission[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error("Session permissions must be an array")
  return value.map((item) => {
    const rule = record(item)
    const effect = rule.effect ?? rule.action
    if (effect !== "allow" && effect !== "deny" && effect !== "ask")
      throw new Error("Invalid session permission effect")
    return {
      action: nativePermissionAction(requiredString(rule.permission ?? rule.action, "permission.action")),
      resource: requiredString(rule.resource ?? rule.pattern, "permission.resource"),
      effect,
    }
  })
}

function jsonRecord(value: unknown): Record<string, JsonValue> {
  // Metadata crosses the native JSON protocol. Serialization rejects cycles/BigInts rather
  // than silently claiming that an unrepresentable original prompt was accepted intact.
  return record(JSON.parse(JSON.stringify(value))) as Record<string, JsonValue>
}

export function toLegacySession(value: unknown): Record<string, unknown> {
  const source = record(value)
  const id = requiredString(source.id, "Native session ID")
  return {
    ...source,
    id,
    slug: source.slug ?? id,
    version: "2.3.2",
    title: source.title ?? "",
    directory: record(source.location).directory ?? source.directory ?? "",
    time: { ...record(source.time) },
    ...(Array.isArray(source.permissions)
      ? {
          permission: source.permissions.map((value) => {
            const rule = record(value)
            return {
              permission: legacyPermissionAction(requiredString(rule.action, "permission.action")),
              pattern: rule.resource,
              action: rule.effect,
            }
          }),
        }
      : {}),
    ...(source.model ? { model: { ...record(source.model), modelID: record(source.model).id } } : {}),
  }
}

function unsupported(name: string) {
  return async () => {
    throw new Error(`OpenCode V2 legacy client does not support ${name}`)
  }
}

/** The SDK's full V1 class is larger than the surface the engine uses. Missing calls
 * fail explicitly; no fetch client, server discovery or independent event stream exists. */
function domain(name: string, methods: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(methods, {
    get(target, key) {
      if (typeof key !== "string" || key === "then") return undefined
      return key in target ? target[key] : unsupported(`${name}.${key}`)
    },
  })
}

export function createLegacyClient(
  ctx: Context,
  getConfig: () => Record<string, unknown>,
): {
  client: PluginInput["client"]
  observe(event: unknown): void
  dispose(): Promise<void>
} {
  const lifetime = new AbortController()
  const touched = new Set<string>()
  const retries = new Map<string, Record<string, unknown>>()
  const options = (input?: unknown) => {
    lifetime.signal.throwIfAborted()
    const supplied = record(input).signal
    return { signal: supplied instanceof AbortSignal ? AbortSignal.any([lifetime.signal, supplied]) : lifetime.signal }
  }
  const get = async (id: string, input?: unknown) => {
    touched.add(id)
    return ctx.session.get({ sessionID: id }, options(input))
  }
  const context = async (id: string, input?: unknown) => ctx.session.context({ sessionID: id }, options(input))
  const list = async (input?: unknown, parentID?: string) => {
    const query = record(record(input).query)
    const result: Awaited<ReturnType<Context["session"]["get"]>>[] = []
    let cursor: string | undefined
    do {
      const page = await ctx.session.list(
        {
          directory: string(query.directory) ?? ctx.location.directory,
          ...(parentID ? { parentID } : {}),
          ...(typeof query.limit === "number" ? { limit: query.limit } : { limit: 100 }),
          ...(cursor ? { cursor } : {}),
        },
        options(input),
      )
      result.push(...page.data)
      cursor = page.cursor.next ?? undefined
    } while (cursor)
    return result
  }
  const messages = async (input: unknown) => {
    const id = sessionID(input)
    const values = toLegacyMessages(id, await context(id, input))
    const limit = record(record(input).query).limit
    return { data: typeof limit === "number" && limit > 0 ? values.slice(-limit) : values }
  }
  const admit = async (input: unknown) => {
    const id = sessionID(input)
    const body = record(record(input).body)
    const requestOptions = options(input)
    touched.add(id)
    if (body.agent !== undefined)
      await ctx.session.switchAgent({ sessionID: id, agent: requiredString(body.agent, "agent") }, requestOptions)
    const model = modelOf(body.model)
    if (model) await ctx.session.switchModel({ sessionID: id, model }, requestOptions)
    const parts = Array.isArray(body.parts) ? body.parts : []
    const files: NonNullable<SessionPromptInput["files"]>[number][] = []
    const agents: NonNullable<SessionPromptInput["agents"]>[number][] = []
    const text: string[] = []
    for (const value of parts) {
      const part = record(value)
      if (part.type === "text") {
        if (typeof part.text !== "string") throw new Error("part.text must be a string")
        text.push(part.text)
      } else if (part.type === "file")
        files.push({
          uri: requiredString(part.url ?? part.uri, "file.url"),
          ...(typeof part.filename === "string" ? { name: part.filename } : {}),
        })
      else if (part.type === "agent") agents.push({ name: requiredString(part.name, "agent.name") })
      else throw new Error(`Unsupported V1 prompt part: ${String(part.type)}`)
    }
    const prompt: SessionPromptInput = {
      sessionID: id,
      text: text.join("\n\n"),
      delivery: "queue",
      resume: body.noReply !== true,
      ...(typeof body.messageID === "string" ? { id: body.messageID } : {}),
      ...(files.length ? { files } : {}),
      ...(agents.length ? { agents } : {}),
      metadata: jsonRecord({ ...record(body.metadata), omoV1: body }),
    }
    return { id, body, receipt: await ctx.session.prompt(prompt, requestOptions) }
  }
  const complete = async (id: string, input?: unknown) => {
    await ctx.session.wait({ sessionID: id }, options(input))
    const info = await get(id, input)
    const history = await context(id, input)
    if (info.outcome === "failed" || info.outcome === "interrupted") {
      const last = history.findLast((item) => item.type === "idle")
      const error = record(record(last).error)
      throw new Error(string(error.message) ?? `Session ${info.outcome}`)
    }
    return history
  }
  const session = domain("session", {
    create: async (input?: unknown) => {
      const body = record(record(input).body)
      const directory = string(record(record(input).query).directory)
      const model = modelOf(body.model)
      const permissions = permissionsOf(body.permission ?? body.permissions)
      const value = await ctx.session.create(
        {
          ...(typeof body.parentID === "string" ? { parentID: body.parentID } : {}),
          ...(typeof body.title === "string" ? { title: body.title } : {}),
          ...(typeof body.agent === "string" ? { agent: body.agent } : {}),
          ...(model ? { model } : {}),
          ...(permissions ? { permissions } : {}),
          ...(directory ? { location: { directory } } : {}),
          ...(body.metadata ? { metadata: jsonRecord(body.metadata) } : {}),
        },
        options(input),
      )
      touched.add(value.id)
      return { data: toLegacySession(value) }
    },
    get: async (input: unknown) => ({ data: toLegacySession(await get(sessionID(input), input)) }),
    list: async (input?: unknown) => ({ data: (await list(input)).map(toLegacySession) }),
    children: async (input: unknown) => ({
      data: (await list(input, sessionID(input)))
        .filter((item) => item.parentID === sessionID(input))
        .map(toLegacySession),
    }),
    delete: async (input: unknown) => {
      const id = sessionID(input)
      await ctx.session.remove({ sessionID: id }, options(input))
      touched.delete(id)
      retries.delete(id)
      return { data: true }
    },
    messages,
    message: async (input: unknown) => {
      const id = requiredString(record(record(input).path).messageID, "messageID")
      const value = (await messages(input)).data.find((item) => item.info.id === id)
      if (!value) throw new Error(`Native session message not found: ${id}`)
      return { data: value }
    },
    promptAsync: async (input: unknown) => {
      await admit(input)
      return { data: undefined }
    },
    prompt: async (input: unknown) => {
      const { id, body, receipt } = await admit(input)
      if (body.noReply === true) return { data: toLegacyMessage(id, { ...receipt.payload, ...receipt, type: "user" }) }
      const history = await complete(id, input)
      const projected = toLegacyMessages(id, history)
      const receiptIndex = projected.findIndex((item) => item.info.id === receipt.id)
      if (receiptIndex < 0) throw new Error(`Native context is missing admitted prompt: ${receipt.id}`)
      const value = projected
        .slice(receiptIndex + 1)
        .findLast((item) => item.info.role === "assistant" && item.info.type === "assistant")
      if (!value) throw new Error(`Native session completed without an assistant response: ${id}`)
      return { data: value }
    },
    abort: async (input: unknown) => ({
      data: (await ctx.session.interrupt({ sessionID: sessionID(input), resume: false }, options(input))).interrupted,
    }),
    status: async (input?: unknown) => {
      const values = await list(input)
      const known = new Set(values.map((item) => item.id))
      for (const id of touched) if (!known.has(id)) values.push(await get(id, input))
      const data: Record<string, unknown> = {}
      for (const value of values) {
        const busy =
          value.time.busy !== undefined && (value.time.idle === undefined || value.time.busy > value.time.idle)
        data[value.id] = busy ? (retries.get(value.id) ?? { type: "busy" }) : { type: "idle" }
      }
      return { data }
    },
    todo: async (input: unknown) => {
      const id = sessionID(input)
      const info = await get(id, input)
      const persisted = record(info.metadata).todos ?? record(info.metadata).todo
      if (Array.isArray(persisted)) return { data: persisted }
      const history = await context(id, input)
      const boundary = info.revert?.messageID
      const index = boundary ? history.findIndex((item) => item.id === boundary) : -1
      for (const message of (index >= 0 ? history.slice(0, index) : history).toReversed()) {
        if (message.type !== "assistant") continue
        for (const part of message.content.toReversed()) {
          if (part.type === "tool" && part.name === "todowrite" && part.state.status === "completed") {
            const todos = part.state.input.todos
            if (!Array.isArray(todos)) throw new Error("Native todowrite returned malformed todos")
            return { data: todos }
          }
        }
      }
      // This is an observed absence after reading the native persisted history.
      return { data: [] }
    },
    summarize: async (input: unknown) => {
      const id = sessionID(input)
      const body = record(record(input).body)
      if (body.modelID !== undefined || body.providerID !== undefined) {
        const model = modelOf(body)
        if (model) await ctx.session.switchModel({ sessionID: id, model }, options(input))
      }
      await ctx.session.compact({ sessionID: id, delivery: "queue" }, options(input))
      const history = await complete(id, input)
      const compacted = history.findLast((item) => item.type === "compaction")
      if (!compacted || compacted.type !== "compaction")
        throw new Error("Native compaction completed without a compaction record")
      if (compacted.status === "failed") throw new Error(compacted.error.message)
      if (compacted.status !== "completed") throw new Error("Native compaction has not completed")
      return { data: true }
    },
  })
  const methods = {
    session,
    app: domain("app", {
      agents: async (input?: unknown) => ({
        data: (await ctx.agent.list(undefined, options(input))).data.map((agent) => ({
          ...agent,
          name: agent.id,
          ...(agent.model ? { model: { ...agent.model, modelID: agent.model.id } } : {}),
        })),
      }),
      skills: async (input?: unknown) => ({
        data: (await ctx.skill.list(undefined, options(input))).data.map((skill) => ({
          ...skill,
          location: skill.path,
        })),
      }),
      log: async (input?: unknown) => {
        log("[opencode-v2]", record(record(input).body))
        return { data: true }
      },
    }),
    config: domain("config", {
      get: async () => {
        options()
        return { data: getConfig() }
      },
    }),
    provider: domain("provider", {
      list: async (input?: unknown) => {
        const [providers, models, selected] = await Promise.all([
          ctx.provider.list(undefined, options(input)),
          ctx.model.list(undefined, options(input)),
          ctx.model.default(undefined, options(input)),
        ])
        const all = providers.data.map((provider) => ({
          ...provider,
          models: Object.fromEntries(
            models.data
              .filter((model) => model.providerID === provider.id)
              .map((model) => [model.id, toLegacyModel(model, provider)]),
          ),
        }))
        return {
          data: {
            all,
            connected: providers.data
              .filter((provider) => provider.activation !== "disabled")
              .map((provider) => provider.id),
            default: selected.data ? { [selected.data.providerID]: selected.data.id } : {},
          },
        }
      },
    }),
    tui: domain("tui", {
      showToast: async (input?: unknown) => {
        log("[opencode-v2] toast", record(record(input).body))
        return { data: true }
      },
    }),
  }
  return {
    client: domain("client", methods) as unknown as PluginInput["client"],
    observe(value: unknown) {
      if (lifetime.signal.aborted) return
      const event = record(value)
      const data = record(event.data)
      const id = string(data.sessionID)
      if (!id) return
      touched.add(id)
      if (event.type === "session.status") {
        const status = record(data.status)
        if (status.type === "retry") retries.set(id, { ...status })
        else retries.delete(id)
      }
      if (event.type === "session.retry.scheduled")
        retries.set(id, { type: "retry", attempt: data.attempt, message: record(data.error).message, next: data.at })
      if (
        event.type === "session.execution.started" ||
        event.type === "session.execution.succeeded" ||
        event.type === "session.execution.failed" ||
        event.type === "session.execution.interrupted"
      )
        retries.delete(id)
      if (event.type === "session.deleted") {
        touched.delete(id)
        retries.delete(id)
      }
    },
    async dispose() {
      lifetime.abort(new Error("OpenCode V2 legacy client disposed"))
      touched.clear()
      retries.clear()
    },
  }
}
