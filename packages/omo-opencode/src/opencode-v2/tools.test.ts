import { describe, expect, it } from "bun:test"
import { tool } from "@opencode-ai/plugin/tool"
import { normalizeToolArgSchemas } from "../plugin/normalize-tool-arg-schemas"
import { jsonSchema, toNativeTool } from "./tools"

describe("native tools over original OMO definitions", () => {
  it("exports normalized argument graphs without reentering V1 JSON-schema overrides", () => {
    const definition = normalizeToolArgSchemas({
      args: {
        text: tool.schema.string().min(3).describe("A constrained value"),
        optional: tool.schema.object({ value: tool.schema.number().int().min(1) }).optional(),
      },
    })
    const internal = definition.args.text._zod as unknown as Record<string, unknown>
    const original = internal.toJSONSchema
    const schema = jsonSchema(definition.args)
    expect(schema.properties).toMatchObject({
      text: { type: "string", minLength: 3, description: "A constrained value" },
    })
    expect(schema.required).toEqual(["text"])
    expect(internal.toJSONSchema).toBe(original)
    expect(jsonSchema(definition.args)).toEqual(schema)
  })
  it("forwards permission denials and complete native execution identity", async () => {
    const denial = new Error("User rejected this action")
    let received: Record<string, unknown> | undefined
    const assertions: Record<string, unknown>[] = []
    const signal = new AbortController().signal
    const native = toNativeTool(
      "task",
      {
        description: "delegate",
        args: {},
        execute: async (_, context) => {
          received = context as unknown as Record<string, unknown>
          await context.ask({
            permission: "bash",
            patterns: ["rm *"],
            always: ["rm *"],
            metadata: { command: "rm x" },
          })
          return "unreachable"
        },
      },
      {
        location: { directory: "/work/tree", project: { canonical: "/work" } },
        permission: {
          assert: async (input: Record<string, unknown>) => {
            assertions.push(input)
            throw denial
          },
        },
      } as never,
    )
    expect(native.options).toEqual({ codemode: false, permission: "subagent" })
    await expect(
      native.execute({}, {
        sessionID: "ses_1",
        messageID: "msg_1",
        agent: "prometheus",
        id: "call_1",
        signal,
        progress: async () => {},
      } as never),
    ).rejects.toBe(denial)
    expect(received).toMatchObject({
      sessionID: "ses_1",
      messageID: "msg_1",
      callID: "call_1",
      agent: "prometheus",
      directory: "/work/tree",
      worktree: "/work",
      abort: signal,
    })
    expect(assertions[0]).toMatchObject({
      sessionID: "ses_1",
      agent: "prometheus",
      action: "shell",
      resources: ["rm *"],
      source: { type: "tool", messageID: "msg_1", id: "call_1" },
    })
  })
  it("retains tool title and metadata and reports progress", async () => {
    const progress: unknown[] = []
    const native = toNativeTool(
      "proof",
      {
        description: "proof",
        args: {},
        execute: async (_, context) => {
          context.metadata({ title: "working", metadata: { stage: 1 } })
          return "complete"
        },
      },
      { location: { directory: "/work", project: { canonical: "/work" } } } as never,
    )
    const result = await native.execute({}, {
      sessionID: "s",
      messageID: "m",
      agent: "a",
      id: "c",
      signal: new AbortController().signal,
      progress: async (update: unknown) => {
        progress.push(update)
      },
    } as never)
    expect(result).toEqual({ content: "complete", metadata: { title: "working", stage: 1 } })
    expect(progress).toEqual([{ title: "working", stage: 1 }])
  })
  it("checks the requested subagent resource before executing original delegation", async () => {
    let executed = false
    const resources: unknown[] = []
    const denial = new Error("Oracle is denied")
    const native = toNativeTool(
      "task",
      {
        description: "delegate",
        args: { subagent_type: tool.schema.string() },
        execute: async () => {
          executed = true
          return "should not run"
        },
      },
      {
        location: { directory: "/work", project: { canonical: "/work" } },
        permission: {
          assert: async (input: { resources: string[] }) => {
            resources.push(input.resources)
            throw denial
          },
        },
      } as never,
    )
    await expect(
      native.execute({ subagent_type: "oracle" }, {
        sessionID: "s",
        messageID: "m",
        agent: "a",
        id: "c",
        signal: new AbortController().signal,
        progress: async () => {},
      } as never),
    ).rejects.toBe(denial)
    expect(resources).toEqual([["oracle"]])
    expect(executed).toBe(false)
  })
})
