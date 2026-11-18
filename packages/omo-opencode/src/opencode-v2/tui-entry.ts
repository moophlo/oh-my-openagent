import * as Plugin from "@opencode/plugin/tui/plugin"

/** Native keymap registration makes the runtime inspectable from the V2 TUI. */
export function registerOpenCodeV2Tui(context: Plugin.Context): void {
  context.keymap.layer(() => ({
    commands: [
      {
        id: "omo.status",
        title: "OMO: show orchestration status",
        description: "Show the registered original OMO agents in this workspace",
        group: "OMO",
        palette: true,
        slash: { name: "omo-status" },
        run: async () => {
          await context.data.location.agent.sync(context.location)
          const agents = context.data.location.agent.list(context.location) ?? []
          const omo = agents.filter((agent) =>
            /sisyphus|prometheus|atlas|hephaestus|oracle|librarian|explore|momus|metis/i.test(agent.id),
          )
          await context.ui.dialog.alert({
            title: "Oh My OpenAgent",
            message: omo.some((agent) => /sisyphus|prometheus|atlas|hephaestus|librarian|momus|metis/i.test(agent.id))
              ? `Original orchestration engine active.\n\n${omo
                  .filter((agent) => !agent.hidden)
                  .map((agent) => agent.name)
                  .join("\n")}\n\nUse /ulw-loop, /ulw-execute or the task tool for delegated work.`
              : "The OMO server adapter has no registered agents in this workspace. Check the server plugin configuration and logs.",
          })
        },
      },
    ],
  }))
}

export const opencodeV2Tui = Plugin.define({
  id: "oh-my-openagent:tui",
  setup: registerOpenCodeV2Tui,
})
