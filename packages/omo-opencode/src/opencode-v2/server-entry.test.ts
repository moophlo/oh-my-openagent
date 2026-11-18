import { describe, expect, it } from "bun:test"
import { setupOpenCodeV2 } from "./server-entry"

describe("native setup using the original engine", () => {
  it("runs config once, keeps delivering after a failing hook, and disposes every registration", async () => {
    let configCalls = 0
    let factoryHost: unknown
    let observed = 0
    let delivered = 0
    let disposed = 0
    let registered = 0
    let legacyDisposed = 0
    let engineDisposed = 0
    let resolveDelivered: () => void = () => {}
    const complete = new Promise<void>((resolve) => {
      resolveDelivered = resolve
    })
    const registration = async () => {
      registered++
      return {
        dispose: async () => {
          disposed++
        },
      }
    }
    const context = {
      location: { directory: "/repo/tree", project: { canonical: "/repo", id: "p" } },
      agent: { list: async () => ({ data: [] }), transform: registration },
      provider: { list: async () => ({ data: [] }), transform: registration },
      model: { list: async () => ({ data: [] }), default: async () => ({ data: null }) },
      mcp: { transform: registration },
      skill: { transform: registration },
      command: { transform: registration, list: async () => ({ data: [] }) },
      tool: { transform: registration, hook: registration },
      session: { hook: registration },
      event: {
        subscribe: async function* () {
          yield { type: "session.idle", data: { sessionID: "s" } }
          yield { type: "session.idle", data: { sessionID: "s" } }
        },
      },
    }
    const cleanup = await setupOpenCodeV2(context as never, {
      createLegacyClient: (() => ({
        client: {},
        observe: () => {
          observed++
        },
        dispose: async () => {
          legacyDisposed++
        },
      })) as never,
      createPluginModule: ((_deps: unknown, runtime: unknown) => {
        factoryHost = runtime
        return {
          server: async (input: { directory: string; worktree: string; serverUrl?: URL }) => {
            expect(input.directory).toBe("/repo/tree")
            expect(input.worktree).toBe("/repo")
            expect(input.serverUrl).toBeUndefined()
            return {
              config: async () => {
                configCalls++
              },
              tool: {},
              event: async () => {
                delivered++
                if (delivered === 1) throw new Error("one bad event")
                resolveDelivered()
              },
              dispose: async () => {
                engineDisposed++
              },
            }
          },
        }
      }) as never,
    })
    await complete
    expect(configCalls).toBe(1)
    expect(factoryHost).toEqual({ host: "opencode-v2" })
    expect(observed).toBe(2)
    expect(delivered).toBe(2)
    await cleanup()
    await cleanup()
    expect(registered).toBeGreaterThan(0)
    expect(disposed).toBe(registered)
    expect(legacyDisposed).toBe(1)
    expect(engineDisposed).toBe(1)
  })
})
