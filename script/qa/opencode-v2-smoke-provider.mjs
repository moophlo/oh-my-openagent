import http from "node:http"

// Deliberately scripted model responses. This tests the real host/plugin tool path,
// not model intelligence, and never sends prompts or credentials off the machine.
export async function startProvider() {
  const requests = []
  const counters = new Map()
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url?.includes("chat/completions")) {
      response.writeHead(404).end()
      return
    }
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    const messages = body.messages ?? []
    const users = messages.filter((message) => message.role === "user")
    const all = JSON.stringify(messages)
    const latest = JSON.stringify(users.at(-1)?.content ?? "")
    const branch = all.includes("OMO_QA_BG_PARENT") ? "background"
      : all.includes("OMO_QA_DELEGATE") ? "delegate"
      : latest.includes("OMO_QA_CHILD") ? "child"
      : latest.includes("OMO_QA_DENY") ? "deny"
      : latest.includes("OMO_QA_UNKNOWN") ? "unknown"
      : latest.includes("OMO_QA_READ") ? "read"
      : latest.includes("OMO_QA_SKILL") ? "skill"
      : latest.includes("OMO_QA_ULW") ? "ulw" : "auxiliary"
    const count = counters.get(branch) ?? 0
    counters.set(branch, count + 1)
    const tools = (body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean)
    requests.push({ branch, tools, ultrawork: /ULTRAWORK MODE|ultrawork-mode/i.test(all), messages })
    let content = `OMO_QA_${branch.toUpperCase()}_OK`
    let call
    if (branch === "delegate" && count === 0) call = {
      name: tools.find((name) => name === "task") ?? "task",
      arguments: JSON.stringify({ description: "QA delegated child", prompt: "OMO_QA_CHILD: return OMO_QA_CHILD_OK", subagent_type: "explore", run_in_background: false, load_skills: [] }),
    }
    if (branch === "background" && count === 0) call = {
      name: "task", arguments: JSON.stringify({ description: "QA background child", prompt: "OMO_QA_CHILD background: return OMO_QA_CHILD_OK", subagent_type: "explore", run_in_background: true, load_skills: [] }),
    }
    if (branch === "background" && count === 1) content = "OMO_QA_PARENT_WAITING"
    if (branch === "background" && count === 2) call = {
      name: "background_output", arguments: JSON.stringify({ task_id: all.match(/bg_[a-zA-Z0-9]+/)?.[0] ?? "bg_missing" }),
    }
    if (branch === "background" && count >= 3) content = "OMO_QA_BG_PARENT_OK"
    if (branch === "read" && count === 0) {
      const schema = body.tools?.find((tool) => tool.function?.name === "read")?.function?.parameters?.properties ?? {}
      call = { name: "read", arguments: JSON.stringify({ ["path" in schema ? "path" : "filePath"]: "qa-proof.txt" }) }
    }
    if (branch === "unknown" && count === 0) call = {
      name: "task", arguments: JSON.stringify({ description: "QA unknown agent", prompt: "Return", subagent_type: "omo-qa-agent-that-does-not-exist", run_in_background: false, load_skills: [] }),
    }
    if (branch === "skill" && count === 0) call = { name: "skill", arguments: JSON.stringify({ name: "qa-proof" }) }
    if (branch === "deny" && count === 0) call = { name: "skill", arguments: JSON.stringify({ name: "qa-proof" }) }
    if (branch === "child" && latest.includes("background")) await new Promise((resolve) => setTimeout(resolve, 1200))
    const id = `chatcmpl-qa-${requests.length}`
    const base = { id, object: "chat.completion.chunk", created: 1, model: "qa-model" }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    emit({ role: "assistant" })
    if (call) {
      emit({ tool_calls: [{ index: 0, id: `call_qa_${requests.length}`, type: "function", function: call }] })
      emit({}, "tool_calls")
    } else {
      emit({ content })
      emit({}, "stop")
    }
    response.write("data: [DONE]\n\n")
    response.end()
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }),
  }
}
