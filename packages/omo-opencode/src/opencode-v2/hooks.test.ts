import { describe, expect, it } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { registerHooks } from "./hooks"
import { messageView, systemView, type NativeMessage } from "./messages"
import { createHashlineReadEnhancerHook } from "../hooks/hashline-read-enhancer/hook"
import { createPrometheusMdOnlyHook } from "../hooks/prometheus-md-only"
import { createToolExecuteBeforeHandler } from "../plugin/tool-execute-before"
import { clearSessionAgent, updateSessionAgent } from "../features/claude-code-session-state"

type Callback = (input: Record<string, unknown>) => Promise<void>
function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing ${label}`)
  return value
}

async function harness(hooks: Partial<Hooks>) {
  const handlers = new Map<string, Callback>()
  let disposed = 0
  const hook = async (name: string, callback: Callback) => {
    handlers.set(name, callback)
    return {
      dispose: async () => {
        disposed++
      },
    }
  }
  const registrations: { dispose: () => Promise<void> }[] = []
  const context = {
    location: { directory: "/repo" },
    session: {
      hook,
      get: async () => ({ agent: "prometheus", model: { providerID: "local", id: "proof" } }),
    },
    tool: { hook },
  }
  await registerHooks(context as never, hooks as Hooks, registrations)
  return {
    run: async (name: string, event: Record<string, unknown>) => {
      const handler = required(handlers.get(name), `registered hook ${name}`)
      await handler(event)
    },
    registrations,
    get disposed() {
      return disposed
    },
  }
}

describe("native original hook bridge", () => {
  it("uses the session's selected agent rather than @agent attachments", async () => {
    let selected: unknown
    const h = await harness({
      "chat.message": async (input, output) => {
        selected = input.agent
        output.parts.push({ type: "text", text: "injected" } as never)
      },
    })
    const event = {
      sessionID: "ses_1",
      messageID: "msg_1",
      prompt: { text: "hello", agents: [{ name: "explore" }] },
    }
    await h.run("prompt", event)
    expect(selected).toBe("prometheus")
    expect(event.prompt.text).toBe("hello\n\ninjected")
    expect(JSON.stringify(event)).not.toContain("undefined")
  })
  it("retains marker-less synthetic continuation flags and respects host-edited prompt text", async () => {
    let received: unknown
    const h = await harness({
      "chat.message": async (_input, output) => {
        received = output.parts
      },
    })
    const event = {
      sessionID: "s",
      messageID: "m",
      prompt: { text: "host edited continue" },
      metadata: {
        omoV1: {
          parts: [{ type: "text", text: "continue", synthetic: true, metadata: { compaction_continue: true } }],
        },
      },
    }
    await h.run("prompt", event)
    expect(received).toEqual([
      { type: "text", text: "host edited continue", synthetic: true, metadata: { compaction_continue: true } },
    ])
    expect(event.prompt.text).toBe("host edited continue")
    expect(event.metadata.omoV1.parts[0]?.metadata.compaction_continue).toBe(true)
  })
  it("projects native paths for write guards and propagates denial", async () => {
    const denial = new Error("Prometheus cannot write source files")
    const h = await harness({
      "tool.execute.before": async (_input, output) => {
        expect(output.args.filePath).toBe("/repo/src/x.ts")
        expect(output.args.path).toBeUndefined()
        throw denial
      },
    })
    await expect(
      h.run("execute.before", {
        tool: "write",
        input: { path: "/repo/src/x.ts", content: "x" },
        sessionID: "s",
        id: "c",
      }),
    ).rejects.toBe(denial)
  })
  it("runs the original Prometheus write guard against a native path argument", async () => {
    updateSessionAgent("v2-prometheus-proof", "prometheus")
    const ctx = { directory: "/repo", client: {} } as never
    const before = createToolExecuteBeforeHandler({
      ctx,
      hooks: { prometheusMdOnly: createPrometheusMdOnlyHook(ctx) } as never,
    })
    const h = await harness({ "tool.execute.before": before })
    try {
      await expect(
        h.run("execute.before", {
          tool: "write",
          input: { path: "/repo/source.ts", content: "blocked" },
          sessionID: "v2-prometheus-proof",
          id: "call_1",
        }),
      ).rejects.toThrow("Prometheus is a planning agent")
    } finally {
      clearSessionAgent("v2-prometheus-proof")
    }
  })
  it("runs the original hashline enhancer on native reads and preserves the native header", async () => {
    const enhancer = createHashlineReadEnhancerHook({} as never, { hashline_edit: { enabled: true } })
    const h = await harness({ "tool.execute.after": enhancer["tool.execute.after"] })
    const event = {
      tool: "read",
      input: { path: "/repo/a.ts" },
      sessionID: "s",
      id: "c",
      status: "completed",
      result: { content: "Read file /repo/a.ts, lines 1-2\n1: const x = 1\n2: done", metadata: {} },
    }
    await h.run("execute.after", event)
    expect(event.result.content).toMatch(
      /^Read file \/repo\/a.ts, lines 1-2\n1#[A-Z0-9]+\|const x = 1\n2#[A-Z0-9]+\|done$/,
    )
    expect(event.result.content).not.toContain("<content>")
    const unchanged = { ...event, result: { content: "Read file /repo/a.ts, lines 1-1\n1: raw", metadata: {} } }
    const plain = await harness({})
    await plain.run("execute.after", unchanged)
    expect(unchanged.result.content).toBe("Read file /repo/a.ts, lines 1-1\n1: raw")
  })
  it("writes arguments, result mutations, title and metadata back to native drafts", async () => {
    const h = await harness({
      "tool.execute.before": async (input, output) => {
        expect(input.tool).toBe("read")
        output.args = { filePath: "/repo/changed.ts", limit: 20 }
      },
      "tool.execute.after": async (input, output) => {
        expect(input.args).toMatchObject({ filePath: "/repo/changed.ts" })
        output.output = "1#AB|changed"
        output.title = "read enhanced"
        output.metadata = { changed: true }
      },
    })
    const before = { tool: "read", input: { path: "/repo/old.ts" }, sessionID: "s", id: "c" }
    await h.run("execute.before", before)
    expect(before.input).toEqual({ path: "/repo/changed.ts", limit: 20 })
    const after = {
      tool: "read",
      input: before.input,
      sessionID: "s",
      id: "c",
      status: "completed",
      result: { content: "raw", metadata: { title: "old" } },
    }
    await h.run("execute.after", after)
    expect(after.result).toEqual({
      content: "1#AB|changed",
      metadata: { title: "read enhanced", changed: true },
    })
  })
  it("keeps deletions/reorder and changed tool results while preserving rich native content", async () => {
    const native: NativeMessage[] = [
      { id: "one", role: "user", content: [{ type: "text", text: "remove me" }] },
      {
        id: "two",
        role: "assistant",
        providerMetadata: { proof: true },
        content: [
          { type: "reasoning", text: "thinking", providerMetadata: { secret: "preserve" } },
          {
            type: "tool-call",
            id: "call_1",
            name: "read",
            input: { path: "/a" },
            cache: { type: "ephemeral" },
          },
        ],
      },
      {
        id: "three",
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "call_1",
            name: "read",
            result: { type: "text", value: "old" },
            providerMetadata: { proof: "kept" },
          },
        ],
      },
      {
        id: "four",
        role: "user",
        content: [
          { type: "file", uri: "file:///a", mime: "image/png" },
          { type: "text", text: "last" },
        ],
      },
    ]
    const view = messageView("s", native)
    expect(view.apply(view.messages)).toEqual(native)
    const assistant = required(view.messages[1], "assistant tool-call message")
    const toolResult = required(view.messages[2], "tool-result message")
    const lastUser = required(view.messages[3], "trailing user message")
    const state = required(assistant.parts[1], "read tool-call part").state as Record<string, unknown>
    state.output = "changed"
    const updated = view.apply([lastUser, assistant, toolResult])
    expect(updated.map((message) => message.id)).toEqual(["four", "two", "three"])
    expect(updated[1]?.providerMetadata).toEqual({ proof: true })
    expect(updated[1]?.content[0]).toEqual(native[1]?.content[0])
    expect(updated[2]?.content[0]).toMatchObject({
      result: { type: "text", value: "changed" },
      providerMetadata: { proof: "kept" },
    })
    expect(updated[0]?.content[0]).toEqual(native[3]?.content[0])
    const cloned = view.apply(
      [assistant, toolResult].map((message) => ({
        ...message,
        parts: message.parts.map((part) =>
          part.type === "tool" ? { ...part, state: { ...(part.state as object), output: "cloned output" } } : part,
        ),
      })),
    )
    expect(cloned[1]?.content[0]).toMatchObject({
      result: { type: "text", value: "cloned output" },
      providerMetadata: { proof: "kept" },
    })
    const removedPair = view.apply([
      {
        ...assistant,
        parts: assistant.parts.filter((part) => part.type !== "tool"),
      },
      toolResult,
    ])
    expect(removedPair).toHaveLength(1)
    expect(removedPair[0]?.content.some((part) => part.type === "tool-call" || part.type === "tool-result")).toBe(false)
    const system = systemView([
      { type: "text", text: "A", cache: true },
      { type: "text", text: "B", metadata: { proof: true } },
    ])
    expect(system.apply(["B"])).toEqual([{ type: "text", text: "B", metadata: { proof: true } }])
  })
  it("applies generation scalar removals and native maxTokens consistently", async () => {
    const h = await harness({
      "chat.params": async (_input, output) => {
        delete output.temperature
        output.maxOutputTokens = 321
        output.options = { reasoningEffort: "high" }
      },
    })
    const event = {
      sessionID: "s",
      agent: "a",
      model: { providerID: "local", id: "proof" },
      system: [],
      messages: [],
      tools: {},
      options: { temperature: 0.7, maxTokens: 1000 },
    }
    await h.run("context", event)
    expect(event.options).toEqual({ maxTokens: 321, reasoningEffort: "high" })
  })
  it("does not reuse an older internal prompt's system/tools for a new user prompt", async () => {
    const h = await harness({})
    const event = {
      sessionID: "s",
      agent: "a",
      model: { providerID: "local", id: "proof" },
      system: [],
      tools: { shell: { description: "shell", input: {} } },
      options: {},
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "internal" }],
          metadata: { omoV1: { system: "old internal system", tools: { bash: false } } },
        },
        { role: "user", content: [{ type: "text", text: "new native prompt" }] },
      ],
    }
    await h.run("context", event)
    expect(event.system).toEqual([])
    expect(event.tools.shell).toBeDefined()
  })
})
