import { describe, expect, it } from "bun:test"
import tuiModule from "../tui"
import { registerOpenCodeV2Tui } from "./tui-entry"

describe("OpenCode V2 TUI integration", () => {
  it("registers a native status command that inspects real registered agents", async () => {
    const commands: { id: string; slash: { name: string }; run: () => Promise<void> }[] = []
    const dialogs: { title: string; message: string }[] = []
    let syncs = 0
    registerOpenCodeV2Tui({
      keymap: {
        layer: (factory: () => { commands: typeof commands }) => commands.push(...factory().commands),
      },
      data: {
        location: {
          agent: {
            sync: async () => {
              syncs++
            },
            list: () => [{ id: "sisyphus", name: "Sisyphus", hidden: false }],
          },
        },
      },
      ui: {
        dialog: {
          alert: async (dialog: (typeof dialogs)[number]) => {
            dialogs.push(dialog)
          },
        },
      },
    } as never)
    expect(commands[0]?.id).toBe("omo.status")
    expect(commands[0]?.slash.name).toBe("omo-status")
    await commands[0]?.run()
    expect(syncs).toBe(1)
    expect(dialogs[0]?.message).toContain("Sisyphus")
    expect(dialogs[0]?.message).toContain("engine active")
  })
  it("retains the original V1 TUI entry alongside native setup", () => {
    expect(typeof tuiModule.tui).toBe("function")
    expect(typeof tuiModule.setup).toBe("function")
  })
})
