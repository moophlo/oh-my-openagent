import type { PluginInput } from "@opencode-ai/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"

/** The original engine receives an in-process client, never invented V1 HTTP routes. */
export function buildV1Input(context: Context, client: PluginInput["client"]): PluginInput {
  const directory = context.location.directory
  return {
    client,
    project: {
      ...context.location.project,
      worktree: context.location.project.canonical,
      time: { created: 0 },
    },
    directory,
    worktree: context.location.project.canonical,
    serverUrl: undefined,
    $: typeof Bun === "undefined" ? undefined : Bun.$,
    experimental_workspace: { register() {} },
  } as unknown as PluginInput
}
