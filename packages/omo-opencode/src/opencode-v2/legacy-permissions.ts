/** V1 tool permissions retain their meaning after the native tool rename. */
export function nativePermissionAction(action: string): string {
  const aliases: Record<string, string> = {
    bash: "shell",
    task: "subagent",
    write: "edit",
    patch: "edit",
    apply_patch: "edit",
  }
  return aliases[action] ?? action
}

/** Native tool names exposed through the original V1 permission lookup. */
export function legacyPermissionAction(action: string): string {
  return action === "shell" ? "bash" : action === "subagent" ? "task" : action
}
