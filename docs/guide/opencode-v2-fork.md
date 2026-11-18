# Sisyphus in OpenCode 2

This modified fork runs the original Oh My OpenAgent plugin inside OpenCode 2. It retains the Sisyphus orchestrator, the original agent prompt builders, category routing, tools, skills, and lifecycle hooks through a V2 adapter. The upstream project and its license notices remain credited in this repository.

OpenCode 2 changed the plugin and server APIs. Upstream's V2 entry only loaded the plugin and directed users toward OmO Native; it did not start the original plugin runtime. This fork starts that runtime and translates its configuration, hooks and client calls into the native V2 domains.

## Build and register the local plugin

Use the repository-pinned **Bun 1.4.4** and OpenCode 2.3.2. Select that Bun version with your version manager or a temporary executable; replacing your global installation is unnecessary. From a directory where you keep source checkouts:

```bash
git clone https://github.com/moophlo/oh-my-openagent.git
cd oh-my-openagent
bun install --ignore-scripts
bun script/build-opencode-v2.ts
pwd
```

The focused build emits the server and TUI bundles, the local LSP support bundles, and bundled skill assets. It materializes the pinned frontend references and browser runtime before copying them; the first build may download the pinned Git submodules. It does not build or install the native OmO application, Codex integration or Desktop application. Keep the checkout and its installed dependencies in place.

Add the checkout's absolute path to `plugins` in your OpenCode `opencode.jsonc`, for example:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/oh-my-openagent"],
}
```

Replace an existing `oh-my-openagent` or `oh-my-opencode` registration with this path so that OpenCode loads one copy. A V2 server plugin registration also loads the package's TUI part; a separate `cli.json` entry is unnecessary. Restart the OpenCode server and TUI after changing the registration or rebuilding.

Keep your existing provider logins. The current upstream configuration loader uses `~/.omo/omo.jsonc` and project `.omo/omo.jsonc`, with OpenCode-specific settings inside an `"[opencode]"` object. It migrates older `oh-my-openagent.json`/`.jsonc` files when the original plugin runtime starts. Preserve a backup before your first launch. Keep agent and category model overrides in that OpenCode block and pick models available in your OpenCode installation.

To update a source installation, pull this fork and repeat the dependency and focused build commands. To roll back, restore your previous plugin registration and restart OpenCode.

## Check the installation

Run `opencode --version`, then use `opencode debug agents` and inspect the plugin list. Sisyphus and the other original agents should be present; simply seeing the plugin ID marked active is insufficient, because upstream's loading-only entry also passed that check.

The automated local smoke driver uses the real OpenCode binary and a deterministic HTTP model fixture. It isolates the home directory, all XDG roots, the working project and temporary files, makes no paid model requests, and checks that real session counts and configuration hashes stay unchanged.

```bash
node script/qa/opencode-v2-smoke.mjs --opencode "$(command -v opencode)" --baseline
node script/qa/opencode-v2-smoke.mjs --opencode "$(command -v opencode)"
```

The first command reproduces the upstream registration-only setup from a pinned source snapshot and saves that source with the evidence. The second runs the built fork, checks model requests and tool execution, and performs a tmux TUI boot/input smoke. Evidence is written under the ignored `.omo/evidence/20261118-opencode-v2/` directory. The script requires Node, SQLite and tmux in addition to OpenCode. `--skip-tui` runs only the server scenarios.

On Linux, also check the packaged local LSP support and static skill assets:

```bash
node script/qa/opencode-v2-lsp-smoke.mjs
```

This drives the generated MCP over real Node stdio through initialization, its tool catalog and `lsp_status`, which starts the actual daemon without installing a language server or calling a model. It validates the generated frontend references and browser runtime, isolates the home/XDG/daemon directories, and records cleanup of its proxy, daemon, socket and temporary sandbox in the same evidence directory.

The OpenCode 2.3.2 smoke covers these behaviors:

| Surface | Observed check |
| --- | --- |
| Agents | Original Sisyphus prompt registered; a session without an explicit agent runs as Sisyphus |
| Prompt hooks | `ulw` instructions reach the actual model HTTP request |
| Skills | Original skill tool discovers and returns a local skill; a resource-specific deny rejects execution |
| Delegation | Original `task` runs a real child with `parentID` and returns its output |
| Background work | Original background completion wakes the parent and `background_output` returns the child result |
| Read hooks | With `hashline_edit` enabled, original hashes appear in the actual native read result |
| Error handling | An unknown delegated agent returns an actionable error |
| Events and terminal | Actual tool/execution events arrive over SSE; the TUI boots and accepts composer input |

## Scope and limits

The server adapter uses the original engine rather than shortened replacement Sisyphus prompts. V2 callbacks and session records have different contracts, so behavior is tested against OpenCode 2.3.2; compatibility with future releases needs verification.

The deterministic fixture proves host and plugin wiring, routing, hook transformations, permissions and delegation mechanics. It does not evaluate the quality of real model reasoning or exercise every provider, MCP server or optional Team Mode workflow. Legacy sidebar and BTW panels are not ported to the V2 TUI; the server orchestration and standard OpenCode interface remain usable. The upstream native-app installer and npm package are not releases of this fork.

The existing Sustainable Use License remains in force. This is an independently modified distribution, not an upstream release.
