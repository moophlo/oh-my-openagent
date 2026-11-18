import { describe, expect, it } from "bun:test"
import { createEventTranslator } from "./events"

describe("native event projection for the original background engine", () => {
  it("retains hierarchy, tool state, todo updates and idle/error edges", () => {
    const projector = createEventTranslator()
    expect(
      projector.translate({
        type: "session.created",
        data: { sessionID: "child", parentID: "parent", location: { directory: "/repo" } },
      })[0],
    ).toMatchObject({
      type: "session.created",
      properties: { info: { id: "child", parentID: "parent" } },
    })
    projector.translate({
      type: "session.tool.input.started",
      data: { sessionID: "child", assistantMessageID: "msg_1", id: "call_1", name: "todowrite" },
    })
    projector.translate({
      type: "session.tool.called",
      data: {
        sessionID: "child",
        assistantMessageID: "msg_1",
        id: "call_1",
        input: { todos: [{ content: "done", status: "completed" }] },
      },
    })
    const result = projector.translate({
      type: "session.tool.success",
      data: {
        sessionID: "child",
        assistantMessageID: "msg_1",
        id: "call_1",
        content: [{ type: "text", text: "done" }],
      },
    })
    expect(result[0]).toMatchObject({
      type: "message.part.updated",
      properties: { part: { tool: "todowrite", state: { status: "completed", output: "done" } } },
    })
    expect(result[1]).toEqual({
      type: "todo.updated",
      properties: { sessionID: "child", todos: [{ content: "done", status: "completed" }] },
    })
    expect(projector.translate({ type: "session.idle", data: { sessionID: "child" } })).toEqual([
      { type: "session.idle", properties: { sessionID: "child" } },
    ])
    expect(
      projector.translate({
        type: "session.execution.interrupted",
        data: { sessionID: "child", reason: "user" },
      })[0],
    ).toMatchObject({
      type: "session.error",
      properties: { error: { name: "MessageAbortedError" } },
    })
    projector.clear()
  })
})
