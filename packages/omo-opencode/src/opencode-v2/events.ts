import { record } from "./domains"
import { toLegacySession } from "./legacy-client"
import { legacyToolName } from "./tools"
import { toLegacyError } from "./legacy-messages"

export type LegacyEvent = { type: string; properties: Record<string, unknown> }
/** Native events are projected without querying a second session store or subscribing twice. */
export function createEventTranslator(): {
  translate(event: { type: string; data?: unknown; created?: number }): LegacyEvent[]
  clear(): void
} {
  const tools = new Map<string, { name?: unknown; input?: unknown }>()
  const actors = new Map<string, Record<string, unknown>>()
  return {
    clear: () => {
      tools.clear()
      actors.clear()
    },
    translate: (event) => {
      const data = record(event.data)
      const sessionID = String(data.sessionID ?? "")
      const messageID = String(data.assistantMessageID ?? data.messageID ?? "")
      const identity = { sessionID, messageID }
      const emit = (type: string, properties: Record<string, unknown> = data): LegacyEvent[] => [
        { type, properties: { ...properties, sessionID } },
      ]
      const part = (value: Record<string, unknown>) => emit("message.part.updated", { part: { ...identity, ...value } })
      switch (event.type) {
        case "session.created":
          return emit("session.created", {
            info: toLegacySession({
              ...data,
              id: sessionID,
              directory: record(data.location).directory,
              time: { created: event.created ?? Date.now() },
            }),
          })
        case "session.deleted":
          actors.delete(sessionID)
          for (const key of tools.keys()) if (key.startsWith(`${sessionID}:`)) tools.delete(key)
          return emit("session.deleted", { info: { id: sessionID }, sessionID })
        case "session.execution.started":
          return emit("session.status", { status: { type: "busy" } })
        case "session.execution.failed":
          return emit("session.error", { error: toLegacyError(data.error) })
        case "session.execution.interrupted":
          return emit("session.error", {
            error: {
              name: "MessageAbortedError",
              data: { message: String(data.reason ?? "interrupted") },
            },
          })
        case "session.status":
        case "session.idle":
          return emit(event.type)
        case "session.compaction.ended":
          return emit("session.compacted")
        case "session.compaction.failed":
          return emit("session.error", { error: toLegacyError(data.error) })
        case "session.permissions":
          return emit("session.updated", {
            info: {
              id: sessionID,
              permission: Array.isArray(data.permissions)
                ? data.permissions.map((entry) => {
                    const rule = record(entry)
                    return {
                      permission: legacyToolName(String(rule.action)),
                      pattern: rule.resource,
                      action: rule.effect,
                    }
                  })
                : [],
            },
          })
        case "session.step.started": {
          const actor = {
            id: messageID,
            sessionID,
            role: "assistant",
            agent: data.agent,
            modelID: record(data.model).id,
            providerID: record(data.model).providerID,
            time: { created: data.started ?? event.created },
          }
          actors.set(sessionID, actor)
          return emit("message.updated", { info: actor })
        }
        case "session.step.ended":
        case "session.step.failed":
          return emit("message.updated", {
            info: {
              ...actors.get(sessionID),
              id: messageID,
              sessionID,
              role: "assistant",
              finish: data.finish,
              ...(data.error ? { error: toLegacyError(data.error) } : {}),
              tokens: data.tokens,
              time: {
                ...record(actors.get(sessionID)?.time),
                completed: event.created ?? Date.now(),
              },
            },
          })
        case "session.text.started":
        case "session.reasoning.started":
        case "session.text.ended":
        case "session.reasoning.ended":
          return part({
            id: `${messageID}:${event.type.includes("reasoning") ? "reasoning" : "text"}:${data.ordinal}`,
            type: event.type.includes("reasoning") ? "reasoning" : "text",
            text: data.text ?? "",
          })
        case "session.text.delta":
        case "session.reasoning.delta":
          return emit("message.part.delta", {
            ...identity,
            field: "text",
            delta: data.delta,
            part: {
              ...identity,
              id: `${messageID}:${event.type.includes("reasoning") ? "reasoning" : "text"}:${data.ordinal}`,
              type: event.type.includes("reasoning") ? "reasoning" : "text",
              text: data.delta,
            },
          })
        case "session.tool.input.started":
          tools.set(`${sessionID}:${data.id}`, { name: data.name })
          return part({
            id: data.id,
            callID: data.id,
            type: "tool",
            tool: data.name,
            state: { status: "pending", input: {} },
          })
        case "session.tool.called": {
          const previous = tools.get(`${sessionID}:${data.id}`)
          tools.set(`${sessionID}:${data.id}`, { ...previous, input: data.input })
          return part({
            id: data.id,
            callID: data.id,
            type: "tool",
            tool: previous?.name,
            state: { status: "running", input: data.input, time: { start: event.created } },
          })
        }
        case "session.tool.progress": {
          const tool = tools.get(`${sessionID}:${data.id}`)
          return part({
            id: data.id,
            callID: data.id,
            type: "tool",
            tool: tool?.name,
            state: { status: "running", input: tool?.input, metadata: data.metadata },
          })
        }
        case "session.tool.success":
        case "session.tool.failed": {
          const tool = tools.get(`${sessionID}:${data.id}`)
          tools.delete(`${sessionID}:${data.id}`)
          const output = Array.isArray(data.content)
            ? data.content.map((entry) => record(entry).text ?? "").join("\n")
            : ""
          const events = part({
            id: data.id,
            callID: data.id,
            type: "tool",
            tool: tool?.name,
            state: {
              status: event.type.endsWith("failed") ? "error" : "completed",
              input: tool?.input,
              output,
              error: data.error,
              metadata: data.metadata,
              time: { end: event.created },
            },
          })
          if (
            event.type === "session.tool.success" &&
            tool?.name === "todowrite" &&
            Array.isArray(record(tool.input).todos)
          )
            events.push({
              type: "todo.updated",
              properties: { sessionID, todos: record(tool.input).todos },
            })
          return events
        }
        case "session.synthetic":
          return part({
            id: String(data.messageID ?? event.created),
            type: "text",
            text: data.text,
            synthetic: true,
          })
        case "session.message.content.updated":
          return emit("message.updated", {
            info: { id: messageID, sessionID, role: "assistant" },
            parts: data.content,
          })
        default:
          return []
      }
    },
  }
}
