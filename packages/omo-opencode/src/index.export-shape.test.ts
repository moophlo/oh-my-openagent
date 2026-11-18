import { describe, expect, it } from "bun:test"
import pluginModule, { omoPlugin } from "./index"
import { opencodeV2Server } from "./opencode-v2/server-entry"

describe("oh-my-openagent plugin export shape", () => {
  it("keeps default module and named server exports aligned", () => {
    // given
    const defaultServer = pluginModule.server

    // when
    const namedServer = omoPlugin

    // then
    expect(typeof defaultServer).toBe("function")
    expect(namedServer).toBe(defaultServer)
  })

  it("exposes the native OpenCode 2 setup beside the V1 server entry", () => {
    // given
    const definition: Record<string, unknown> = pluginModule

    // when
    const setup = definition["setup"]

    // then
    expect(definition["id"]).toBe("oh-my-openagent")
    expect(typeof definition["server"]).toBe("function")
    expect(typeof setup).toBe("function")
    expect(setup).toBe(opencodeV2Server.setup)
  })
})
