import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import { createLegacyClient } from "./legacy-client"
import { isSessionComplete } from "../tools/delegate-task/sync-session-turns"
import { isRealUserMessage } from "@oh-my-opencode/utils"

async function bounded<T>(promise: Promise<T>, event: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Waited 2s for ${event}`)), 2000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const nativeSession = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  projectID: "project",
  location: { directory: "/project" },
  title: id,
  time: { created: 1, updated: 2 },
  ...overrides,
})

function fixture(overrides: Record<string, unknown> = {}) {
  const sessions = new Map<string, Record<string, unknown>>([["parent", nativeSession("parent")]])
  const history: unknown[] = []
  const context = {
    location: { directory: "/project" },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const value = sessions.get(sessionID)
        if (!value) throw new Error(`Unknown session: ${sessionID}`)
        return value
      },
      create: async (input: Record<string, unknown>) => {
        const value = nativeSession("child", input)
        sessions.set("child", value)
        return value
      },
      list: async () => ({ data: [...sessions.values()], cursor: {} }),
      remove: async ({ sessionID }: { sessionID: string }) => {
        sessions.delete(sessionID)
      },
      context: async () => history,
      prompt: async (input: Record<string, unknown>) => ({
        id: "user-queued",
        sessionID: input.sessionID,
        type: "user",
        time: { created: 3 },
        payload: { text: input.text },
        delivery: input.delivery,
      }),
      wait: async () => {},
      interrupt: async () => ({ interrupted: false }),
      switchAgent: async () => {},
      switchModel: async () => {},
      compact: async () => ({ id: "compact" }),
      ...overrides,
    },
  } as unknown as Context
  return { context, sessions, history }
}

// Public adapter protocol contracts: the native host and original engine disagree on
// hierarchy, message structure and prompt completion. No existing V1 test crosses this boundary.
describe("V2 legacy client", () => {
  test("creates a real native child with converted model, location and deny permission", async () => {
    const { context, sessions } = fixture()
    const { client } = createLegacyClient(context, () => ({}))
    const result = await client.session.create({
      body: {
        parentID: "parent",
        title: "delegated",
        model: { providerID: "local", modelID: "small" },
        permission: [{ permission: "question", pattern: "*", action: "deny" }],
      } as Record<string, unknown>,
      query: { directory: "/child" },
    })
    expect(result.data?.parentID).toBe("parent")
    expect(sessions.get("child")).toMatchObject({
      parentID: "parent",
      model: { id: "small", providerID: "local" },
      location: { directory: "/child" },
      permissions: [{ action: "question", resource: "*", effect: "deny" }],
    })
    expect((await client.session.children({ path: { id: "parent" } })).data?.map((child) => child.id)).toEqual([
      "child",
    ])
  })

  test("preserves deny permissions across native tool renames", async () => {
    const { context, sessions } = fixture()
    const { client } = createLegacyClient(context, () => ({}))
    const result = await client.session.create({
      body: {
        permission: ["bash", "task", "write", "patch", "apply_patch"].map((permission) => ({
          permission,
          pattern: "*",
          action: "deny",
        })),
      } as Record<string, unknown>,
    })
    expect(sessions.get("child")?.permissions).toEqual([
      { action: "shell", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
      ...["write", "patch", "apply_patch"].map(() => ({ action: "edit", resource: "*", effect: "deny" })),
    ])
  })

  test("exposes native session rules through the V1 permission field", async () => {
    const { context, sessions } = fixture()
    sessions.set(
      "parent",
      nativeSession("parent", {
        permissions: [
          { action: "shell", resource: "*", effect: "deny" },
          { action: "subagent", resource: "explore", effect: "allow" },
        ],
      }),
    )
    const result = await createLegacyClient(context, () => ({})).client.session.get({ path: { id: "parent" } })
    expect((result.data as unknown as Record<string, unknown>).permission).toEqual([
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "task", pattern: "explore", action: "allow" },
    ])
  })

  test("reads native context arrays as V1 messages with tool output, errors, timing and source blocks", async () => {
    const { context, history } = fixture()
    const custom = { type: "future-block", opaque: { retained: true } }
    history.push(
      { id: "u", type: "user", text: "work", time: { created: 3 } },
      {
        id: "a",
        type: "assistant",
        agent: "worker",
        model: { id: "small", providerID: "local" },
        time: { created: 4, completed: 8 },
        finish: "stop",
        metadata: { trace: "retained" },
        tokens: { input: 11, output: 5, reasoning: 1, cache: { read: 2, write: 0 } },
        content: [
          { type: "text", text: "done" },
          {
            type: "tool",
            id: "call",
            name: "bash",
            time: { created: 4, ran: 5, completed: 6 },
            state: { status: "completed", input: { command: "pwd" }, content: [{ type: "text", text: "/project" }] },
          },
          custom,
        ],
        error: { type: "rate-limit", message: "slow down", status: 429 },
      },
    )
    const { client } = createLegacyClient(context, () => ({}))
    const response = await client.session.messages({ path: { id: "parent" } })
    expect(response.data).toHaveLength(2)
    expect(response.data?.[1]?.info).toMatchObject({
      role: "assistant",
      parentID: "u",
      agent: "worker",
      modelID: "small",
      providerID: "local",
      finish: "stop",
      time: { completed: 8 },
      tokens: { input: 11 },
      error: { data: { message: "slow down", statusCode: 429 } },
    })
    expect(response.data?.[1]?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "done" }),
        expect.objectContaining({
          type: "tool",
          tool: "bash",
          callID: "call",
          state: expect.objectContaining({ status: "completed", output: "/project", time: { start: 5, end: 6 } }),
        }),
        expect.objectContaining(custom),
      ]),
    )
    expect((await client.session.message({ path: { id: "parent", messageID: "a" } })).data).toEqual(response.data?.[1])
  })

  test("retains automated part intent while respecting the host's edited prompt text", async () => {
    const { context, history } = fixture()
    history.push({
      id: "u",
      type: "user",
      text: "continue after host edit",
      time: { created: 3 },
      metadata: {
        omoV1: {
          noReply: true,
          parts: [{ type: "text", text: "continue", synthetic: true, metadata: { compaction_continue: true } }],
        },
      },
    })
    const result = await createLegacyClient(context, () => ({})).client.session.messages({ path: { id: "parent" } })
    expect(isRealUserMessage(result.data?.[0] ?? {})).toBe(false)
    expect(result.data?.[0]?.parts[0]).toMatchObject({
      text: "continue after host edit",
      synthetic: true,
      metadata: { compaction_continue: true },
    })
  })

  test("recognizes a completed native child with trailing lifecycle records through the original poller", async () => {
    const { context, history } = fixture()
    history.push(
      { id: "msg_0", type: "agent-switched", agent: "worker", time: { created: 1 } },
      { id: "msg_1", type: "user", text: "work", time: { created: 2 } },
      {
        id: "msg_2",
        type: "assistant",
        agent: "worker",
        model: { id: "small", providerID: "local" },
        time: { created: 3, completed: 4 },
        content: [{ type: "text", text: "done" }],
        finish: "stop",
      },
      { id: "msg_3", type: "idle", outcome: "succeeded", time: { created: 4 } },
    )
    const result = await createLegacyClient(context, () => ({})).client.session.messages({ path: { id: "parent" } })
    expect(isSessionComplete(result.data ?? [])).toBe(true)
    expect(result.data?.map((message) => message.info.id)).toEqual(["msg_1", "msg_2"])
  })

  test("async prompt acknowledges queued admission; synchronous prompt waits for native completion", async () => {
    const entered = deferred<void>()
    const completed = deferred<void>()
    const { context, history, sessions } = fixture({
      wait: async () => {
        entered.resolve()
        await completed.promise
      },
    })
    const adapter = createLegacyClient(context, () => ({}))
    await adapter.client.session.promptAsync({
      path: { id: "parent" },
      body: { parts: [{ type: "text", text: "queued" }] },
    })
    let settled = false
    const answer = adapter.client.session
      .prompt({ path: { id: "parent" }, body: { parts: [{ type: "text", text: "wait" }] } })
      .then((result) => {
        settled = true
        return result
      })
    await bounded(entered.promise, "native wait entry")
    expect(settled).toBe(false)
    history.push(
      { id: "user-queued", type: "user", text: "wait", time: { created: 3 } },
      {
        id: "answer",
        type: "assistant",
        agent: "worker",
        model: { id: "small", providerID: "local" },
        time: { created: 4, completed: 5 },
        content: [{ type: "text", text: "completed answer" }],
        finish: "stop",
      },
    )
    sessions.set(
      "parent",
      nativeSession("parent", { outcome: "succeeded", time: { created: 1, updated: 5, busy: 3, idle: 5 } }),
    )
    completed.resolve()
    expect((await bounded(answer, "completed prompt")).data?.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "completed answer" })]),
    )
    await adapter.dispose()
  })

  test("completes a resumed prompt after earlier native lifecycle records", async () => {
    const { context, history } = fixture()
    history.push(
      { id: "msg_0", type: "agent-switched", agent: "worker", time: { created: 1 } },
      { id: "msg_1", type: "user", text: "old", time: { created: 2 } },
      {
        id: "msg_2",
        type: "assistant",
        agent: "worker",
        model: { id: "small", providerID: "local" },
        time: { created: 3, completed: 4 },
        content: [{ type: "text", text: "old answer" }],
        finish: "stop",
      },
      { id: "msg_3", type: "idle", outcome: "succeeded", time: { created: 4 } },
      { id: "user-queued", type: "user", text: "new", time: { created: 5 } },
      {
        id: "msg_5",
        type: "assistant",
        agent: "worker",
        model: { id: "small", providerID: "local" },
        time: { created: 6, completed: 7 },
        content: [{ type: "text", text: "new answer" }],
        finish: "stop",
      },
      { id: "msg_6", type: "idle", outcome: "succeeded", time: { created: 7 } },
    )
    const result = await createLegacyClient(context, () => ({})).client.session.prompt({
      path: { id: "parent" },
      body: { parts: [{ type: "text", text: "new" }] },
    })
    expect(result.data?.info.id).toBe("msg_5")
  })

  test("propagates native lookup, admission and execution failures", async () => {
    const { context, sessions } = fixture({
      prompt: async () => {
        throw new Error("admission rejected")
      },
    })
    const { client } = createLegacyClient(context, () => ({}))
    await expect(client.session.get({ path: { id: "missing" } })).rejects.toThrow("Unknown session")
    await expect(client.session.promptAsync({ path: { id: "parent" }, body: { parts: [] } })).rejects.toThrow(
      "admission rejected",
    )
    const failed = fixture()
    failed.sessions.set("parent", nativeSession("parent", { outcome: "failed" }))
    failed.history.push({
      id: "failure",
      type: "idle",
      time: { created: 7 },
      outcome: "failed",
      error: { type: "provider", message: "model unavailable" },
    })
    await expect(
      createLegacyClient(failed.context, () => ({})).client.session.prompt({
        path: { id: "parent" },
        body: { parts: [] },
      }),
    ).rejects.toThrow("model unavailable")
    expect(sessions.size).toBe(1)
  })

  test("never returns an older assistant when admitted input is absent or unanswered", async () => {
    const { context, history } = fixture()
    history.push({
      id: "old",
      type: "assistant",
      agent: "worker",
      time: { created: 1, completed: 2 },
      content: [{ type: "text", text: "old answer" }],
      finish: "stop",
    })
    const { client } = createLegacyClient(context, () => ({}))
    await expect(client.session.prompt({ path: { id: "parent" }, body: { parts: [] } })).rejects.toThrow(
      "missing admitted prompt",
    )
    history.push({ id: "user-queued", type: "user", text: "new question", time: { created: 3 } })
    await expect(client.session.prompt({ path: { id: "parent" }, body: { parts: [] } })).rejects.toThrow(
      "without an assistant response",
    )
  })

  test("queues native files and empty text while retaining original per-prompt settings", async () => {
    const admitted = deferred<Record<string, unknown>>()
    const { context } = fixture({
      prompt: async (input: Record<string, unknown>) => {
        admitted.resolve(input)
        return { id: "u", payload: {}, type: "user" }
      },
    })
    const { client } = createLegacyClient(context, () => ({}))
    await client.session.promptAsync({
      path: { id: "parent" },
      body: {
        parts: [
          { type: "text", text: "" },
          { type: "file", mime: "text/plain", url: "data:text/plain;base64,YQ==", filename: "a.txt" },
        ],
        system: "request instructions",
        tools: { bash: false },
        noReply: true,
      },
    })
    expect(await bounded(admitted.promise, "native prompt admission")).toMatchObject({
      sessionID: "parent",
      text: "",
      delivery: "queue",
      resume: false,
      files: [{ uri: "data:text/plain;base64,YQ==", name: "a.txt" }],
      metadata: { omoV1: { system: "request instructions", tools: { bash: false } } },
    })
    await expect(
      client.session.promptAsync({ path: { id: "parent" }, body: { parts: [{ type: "unknown" }] } } as never),
    ).rejects.toThrow("Unsupported V1 prompt part")
  })

  test("reports native busy/idle and actual interruption instead of assuming abort success", async () => {
    const { context, sessions } = fixture()
    sessions.set("parent", nativeSession("parent", { time: { created: 1, updated: 9, busy: 8, idle: 5 } }))
    const { client, observe } = createLegacyClient(context, () => ({}))
    expect((await client.session.status()).data?.parent).toEqual({ type: "busy" })
    observe({
      type: "session.status",
      data: { sessionID: "parent", status: { type: "retry", attempt: 2, message: "rate limited", next: 10 } },
    })
    expect((await client.session.status()).data?.parent).toEqual({
      type: "retry",
      attempt: 2,
      message: "rate limited",
      next: 10,
    })
    expect((await client.session.abort({ path: { id: "parent" } })).data).toBe(false)
    sessions.set(
      "parent",
      nativeSession("parent", { outcome: "interrupted", time: { created: 1, updated: 9, busy: 8, idle: 9 } }),
    )
    expect((await client.session.status()).data?.parent).toEqual({ type: "idle" })
  })

  test("reads actual persisted todo metadata and latest successful native todowrite", async () => {
    const { context, history, sessions } = fixture()
    const todos = [{ id: "t", content: "review", status: "in_progress", priority: "high" }]
    sessions.set("parent", nativeSession("parent", { metadata: { todos } }))
    const { client } = createLegacyClient(context, () => ({}))
    expect((await client.session.todo({ path: { id: "parent" } })).data).toEqual(todos)
    sessions.set("parent", nativeSession("parent"))
    history.push({
      id: "a",
      type: "assistant",
      time: { created: 3 },
      content: [
        {
          type: "tool",
          id: "tc",
          name: "todowrite",
          state: { status: "completed", input: { todos }, content: [{ type: "text", text: "saved" }] },
        },
      ],
    })
    expect((await client.session.todo({ path: { id: "parent" } })).data).toEqual(todos)
  })

  test("disposal cancels an outstanding native wait and rejects new work", async () => {
    const entered = deferred<void>()
    const { context } = fixture({
      wait: async (_input: unknown, options: { signal: AbortSignal }) => {
        entered.resolve()
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
        })
      },
    })
    const adapter = createLegacyClient(context, () => ({}))
    const result = adapter.client.session.prompt({ path: { id: "parent" }, body: { parts: [] } })
    const rejected = result.then(
      () => undefined,
      (error: unknown) => error,
    )
    await bounded(entered.promise, "native wait entry")
    await adapter.dispose()
    const error = await bounded(rejected, "native wait cancellation")
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("disposed")
    await expect(adapter.client.session.get({ path: { id: "parent" } })).rejects.toThrow("disposed")
  })
})
