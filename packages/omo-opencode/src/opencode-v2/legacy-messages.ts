/** Lossless source retention accompanies the V1 projection used by the original engine. */
export type LegacyMessage = { info: Record<string, unknown>; parts: Record<string, unknown>[] }

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function toLegacyError(value: unknown): Record<string, unknown> {
  const source = record(value)
  const message = string(source.message) ?? String(value)
  return {
    ...source,
    name:
      source.type === "interrupted" ? "MessageAbortedError" : source.status !== undefined ? "APIError" : "UnknownError",
    data: {
      ...source,
      message,
      ...(source.status !== undefined
        ? { statusCode: source.status, isRetryable: source.status === 429 || Number(source.status) >= 500 }
        : {}),
    },
  }
}

function toolPart(block: Record<string, unknown>): Record<string, unknown> {
  const state = record(block.state)
  const time = record(block.time)
  const content = Array.isArray(state.content) ? state.content : []
  const output = content
    .flatMap((item) => (typeof record(item).text === "string" ? [String(record(item).text)] : []))
    .join("\n")
  const status = state.status === "streaming" ? "pending" : state.status
  const start = numeric(time.ran) ?? numeric(time.created)
  const end = numeric(time.completed)
  return {
    ...block,
    type: "tool",
    callID: block.id,
    tool: block.name,
    state: {
      ...state,
      status,
      input: state.status === "streaming" ? {} : (state.input ?? {}),
      ...(state.status === "streaming" ? { raw: state.input } : {}),
      ...(state.status === "completed"
        ? { output, title: string(record(state.metadata).title) ?? string(block.name) ?? "tool" }
        : {}),
      ...(state.status === "error"
        ? { error: string(record(state.error).message) ?? String(state.error), nativeError: state.error }
        : {}),
      ...(start !== undefined ? { time: { start, ...(end !== undefined ? { end } : {}) } } : {}),
      ...(content.length ? { attachments: content.filter((item) => record(item).type !== "text") } : {}),
    },
  }
}

export function toLegacyMessage(sessionID: string, value: unknown, previousUserID?: string): LegacyMessage {
  const source = record(value)
  const id = string(source.id)
  if (!id) throw new Error("Native context message is missing its ID")
  const time = record(source.time)
  const model = record(source.model)
  const assistant = source.type === "assistant" || source.type === "compaction" || source.type === "shell"
  const parts: Record<string, unknown>[] = []
  const append = (part: Record<string, unknown>) =>
    parts.push({ ...part, id: string(part.id) ?? `${id}:${parts.length}`, sessionID, messageID: id })
  if (Array.isArray(source.content)) {
    for (const item of source.content) {
      const block = record(item)
      if (block.type === "tool") append(toolPart(block))
      else
        append({
          ...block,
          ...(block.type === "reasoning" && block.time
            ? { time: { start: record(block.time).created, end: record(block.time).completed } }
            : {}),
        })
    }
  } else if (typeof source.text === "string") {
    const original = record(record(source.metadata).omoV1).parts
    const textParts = Array.isArray(original) ? original.filter((part) => record(part).type === "text") : []
    const metadata = textParts.length === 1 ? record(textParts[0]) : {}
    append({ ...metadata, type: "text", text: source.text, ...(source.type !== "user" ? { synthetic: true } : {}) })
  }
  if (source.type === "compaction") {
    append({ type: "compaction", auto: source.reason === "auto" })
    if (typeof source.summary === "string") append({ type: "text", text: source.summary })
  }
  if (source.type === "shell") {
    append({
      type: "tool",
      callID: source.shellID,
      tool: "bash",
      state: {
        status:
          source.status === "running"
            ? "running"
            : source.status === "exited" && source.exit === 0
              ? "completed"
              : "error",
        input: { command: source.command },
        output: record(source.output).output ?? "",
        ...(source.status !== "running" && source.exit !== 0
          ? { error: `Shell ${String(source.status)} (exit ${String(source.exit)})` }
          : {}),
        time: { start: time.created, end: time.completed },
      },
    })
  }
  if (Array.isArray(source.files))
    for (const item of source.files) {
      const file = record(item)
      append({
        ...file,
        type: "file",
        mime: file.mime,
        filename: file.name,
        url:
          typeof file.uri === "string"
            ? file.uri
            : `data:${String(file.mime ?? "application/octet-stream")};base64,${String(file.data ?? "")}`,
      })
    }
  if (Array.isArray(source.agents)) for (const item of source.agents) append({ ...record(item), type: "agent" })
  const info: Record<string, unknown> = {
    ...source,
    id,
    sessionID,
    role: assistant ? "assistant" : "user",
    time: { ...time },
    metadata: { ...record(source.metadata), opencodeV2: source },
    ...(assistant
      ? {
          parentID: string(source.parentID) ?? previousUserID ?? "",
          modelID: model.id ?? "",
          providerID: model.providerID ?? "",
          mode: source.agent ?? "",
          agent: source.agent ?? "",
          path: { cwd: "", root: "" },
          cost: source.cost ?? 0,
          tokens: source.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          ...(source.type === "compaction" ? { summary: true } : {}),
        }
      : {}),
    ...(source.error ? { error: toLegacyError(source.error) } : {}),
  }
  return { info, parts }
}

export function toLegacyMessages(sessionID: string, values: readonly unknown[]): LegacyMessage[] {
  let parentID: string | undefined
  const lifecycle = new Set(["idle", "agent-switched", "model-switched", "location-switched"])
  return values
    .filter((value) => !lifecycle.has(String(record(value).type)))
    .map((value) => {
      const source = record(value)
      if (source.type === "user" || source.type === "synthetic") parentID = string(source.id)
      return toLegacyMessage(sessionID, source, parentID)
    })
}
