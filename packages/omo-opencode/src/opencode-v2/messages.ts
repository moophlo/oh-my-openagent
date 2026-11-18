import { record } from "./domains"

type NativePart = Record<string, unknown>
export type NativeMessage = {
  role: string
  content: NativePart[]
  id?: string
  [key: string]: unknown
}
export type LegacyMessage = { info: Record<string, unknown>; parts: NativePart[] }
function resultText(result: unknown): string {
  const value = record(result)
  if (typeof value.value === "string") return value.value
  if (value.type === "content" && Array.isArray(value.value))
    return value.value.map((part) => record(part).text ?? "").join("\n")
  return value.value === undefined ? "" : JSON.stringify(value.value)
}

/** Keep original rich blocks and metadata while exposing the V1 mutable message shape. */
export function messageView(
  sessionID: string,
  source: readonly NativeMessage[],
  agent?: string,
  model?: unknown,
): {
  messages: LegacyMessage[]
  apply(messages: LegacyMessage[]): NativeMessage[]
} {
  const originals = new Map<string, NativeMessage>()
  const partSource = new WeakMap<NativePart, NativePart>()
  const results = new Map<string, NativePart>()
  const nativeCalls = new Map<string, NativePart>()
  const calls = new Map<string, { part: NativePart; output: string }>()
  for (const message of source)
    for (const part of message.content) {
      if (part.type === "tool-result" && typeof part.id === "string") results.set(part.id, part)
    }
  const messages = source.map((message, index) => {
    const id = message.id ?? `omo-v2-context-${index}`
    originals.set(id, message)
    return {
      info: {
        id,
        sessionID,
        role: message.role === "user" || message.role === "system" ? "user" : "assistant",
        agent,
        model,
        providerID: record(model).providerID,
        modelID: record(model).id,
        metadata: message.metadata,
      },
      parts: message.content.map((part) => {
        let view = { ...part }
        if (part.type === "tool-call") {
          nativeCalls.set(String(part.id), part)
          const result = results.get(String(part.id))
          const output = resultText(result?.result)
          view = {
            type: "tool",
            id: part.id,
            callID: part.id,
            tool: part.name,
            state: {
              status: result ? (record(result.result).type === "error" ? "error" : "completed") : "running",
              input: part.input,
              output,
              error: output,
              metadata: {},
            },
          }
          calls.set(String(part.id), { part: view, output })
        }
        partSource.set(view, part)
        return view
      }),
    }
  })
  return {
    messages,
    apply: (updated) => {
      const updatedCalls = new Map<string, NativePart>()
      for (const message of updated)
        for (const part of message.parts)
          if (part.type === "tool") {
            updatedCalls.set(String(part.callID ?? part.id), part)
          }
      return updated.flatMap((message) => {
        const original = originals.get(String(message.info.id))
        const role =
          original &&
          message.info.role ===
            (original.role === "tool" ? "assistant" : original.role === "system" ? "user" : original.role)
            ? original.role
            : String(message.info.role ?? "assistant")
        const content = message.parts.flatMap((part) => {
          const native =
            partSource.get(part) ??
            (part.type === "tool"
              ? nativeCalls.get(String(part.callID ?? part.id))
              : part.type === "tool-result"
                ? results.get(String(part.id))
                : undefined)
          if (native?.type === "tool-call")
            return [
              {
                ...native,
                id: part.callID ?? native.id,
                name: part.tool ?? native.name,
                input: record(part.state).input ?? native.input,
              },
            ]
          if (native?.type === "tool-result") {
            // V1 stores call and output in one tool part. Removing that part
            // must remove its native result as well as its call.
            if (calls.has(String(native.id)) && !updatedCalls.has(String(native.id))) return []
            const call = calls.get(String(native.id))
            const state = record(updatedCalls.get(String(native.id))?.state)
            const output = state.status === "error" ? state.error : state.output
            if (call && typeof output === "string" && output !== call.output)
              return [
                {
                  ...native,
                  result: { type: state.status === "error" ? "error" : "text", value: output },
                },
              ]
            return [{ ...native, ...part }]
          }
          if (native) return [{ ...native, ...part }]
          if (part.type === "tool") {
            const state = record(part.state)
            return [
              {
                type: "tool-call",
                id: part.callID ?? part.id,
                name: part.tool,
                input: state.input ?? {},
              },
            ]
          }
          return [{ ...part }]
        })
        if (role === "tool" && content.length === 0) return []
        return [
          {
            ...original,
            role,
            content,
          },
        ]
      })
    },
  }
}

export function systemView(source: readonly NativePart[]): {
  system: string[]
  apply(system: string[]): NativePart[]
} {
  return {
    system: source.map((part) => String(part.text ?? "")),
    apply: (texts) => {
      const available = [...source]
      return texts.map((text, index) => {
        let found = available.findIndex((part) => part?.text === text)
        if (found === -1) found = available[index] ? index : available.findIndex(Boolean)
        const original = found === -1 ? undefined : available[found]
        if (found !== -1) delete available[found]
        return { ...original, type: "text", text }
      })
    },
  }
}
