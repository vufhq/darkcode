import { expect, test } from "bun:test";
import { generateText, streamText, tool } from "ai";
import { z } from "zod";
import { createCodexModel, CODEX_RESPONSES_URL, readOpenAIOAuthHeaders } from "./openai-codex";
import { compactWorkingContext } from "./compaction";
import { OPENAI_OAUTH_TOKEN_HEADER, OPENAI_OAUTH_ACCOUNT_ID_HEADER } from "@darkcode/shared";

const credentials = { accessToken: "oauth-access", accountId: "account-1" };

test("real resolver keeps OAuth unmetered and refuses hosted/BYOK fallback even with API keys configured", async () => {
  // Isolate env.ts initialization from other suites' module mocks.
  const script = `
    import { strict as assert } from "node:assert";
    import { resolveChatModel } from ${JSON.stringify(new URL("./models.ts", import.meta.url).href)};
    const keys = { openai: "byok-key" };
    assert.throws(() => resolveChatModel("chatgpt-gpt-5.4", keys), /ChatGPT connection/);
    const resolved = resolveChatModel("chatgpt-gpt-5.4", keys, { accessToken: "oauth-token", accountId: "account" });
    assert.equal(resolved.isMetered, false);
    assert.equal(resolved.provider, "openai-codex");
    assert.equal(resolved.model.modelId, "gpt-5.4");
    assert.equal(resolveChatModel("gpt-5.4", keys).isMetered, false);
    assert.equal(resolveChatModel("gpt-5.4").isMetered, true);
  `;
  const required = Object.fromEntries(["DATABASE_URL", "MOONSHOT_API_KEY", "OPENAI_API_KEY", "CLERK_FRONTEND_API", "CLERK_OAUTH_CLIENT_ID", "CLERK_OAUTH_CLIENT_SECRET", "CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY", "JWT_SECRET", "POLAR_ACCESS_TOKEN", "POLAR_PRODUCT_ID", "POLAR_CREDITS_METER_ID"].map((key) => [key, "test-placeholder"]));
  const processResult = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, ...required, NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([processResult.exited, new Response(processResult.stderr).text()]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});
const usage = { input_tokens: 10, output_tokens: 3 };
const textItem = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Summary", annotations: [] }] };
const completed = { id: "resp_1", model: "gpt-5.4", created_at: 1, status: "completed", output: [textItem], usage };
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function sse(toolCall = false) {
  const item = toolCall ? { id: "fc_1", type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}", status: "completed" } : textItem;
  return new Response([
    event({ type: "response.created", response: { id: "resp_1", model: "gpt-5.4", created_at: 1 } }),
    event({ type: "response.output_item.added", output_index: 0, item: toolCall ? { ...item, arguments: "" } : { ...item, content: [] } }),
    toolCall ? event({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "{}" }) : event({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Summary" }),
    event({ type: "response.output_item.done", output_index: 0, item }),
    event({ type: "response.completed", response: { ...completed, output: [item] } }),
  ].join(""), { headers: { "Content-Type": "text/event-stream" } });
}

function adapter(response: () => Response = () => sse()) {
  const requests: Record<string, unknown>[] = [];
  const model = createCodexModel(credentials, (async (url, init) => {
    expect(String(url)).toBe(CODEX_RESPONSES_URL);
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer oauth-access");
    expect(headers.get("chatgpt-account-id")).toBe("account-1");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("gpt-5.4");
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(typeof body.instructions).toBe("string");
    for (const key of ["max_output_tokens", "temperature", "top_p", "previous_response_id", "truncation"]) expect(body[key]).toBeUndefined();
    requests.push(body);
    return response();
  }) as typeof fetch);
  return { model, requests };
}

test("OAuth is mandatory and separate from API keys", () => {
  expect(() => createCodexModel(undefined)).toThrow("ChatGPT connection");
  expect(readOpenAIOAuthHeaders(new Headers({ "x-darkcode-openai-key": "api-key" }))).toBeUndefined();
  expect(() => readOpenAIOAuthHeaders(new Headers({ [OPENAI_OAUTH_TOKEN_HEADER]: "token" }))).toThrow();
  expect(readOpenAIOAuthHeaders(new Headers({ [OPENAI_OAUTH_TOKEN_HEADER]: "token", [OPENAI_OAUTH_ACCOUNT_ID_HEADER]: "account" }))).toEqual({ accessToken: "token", accountId: "account" });
});

test("streamText uses Codex Responses and preserves instructions and usage", async () => {
  const { model, requests } = adapter();
  const result = streamText({ model, system: "Project instructions", prompt: "Hi", maxOutputTokens: 100, temperature: 1, maxRetries: 0 });
  expect(await result.text).toBe("Summary");
  expect((await result.usage).inputTokens).toBe(10);
  expect(requests[0]?.instructions).toBe("Project instructions");
});

test("streamed tool call and result continuation send full items without stored references", async () => {
  const { model, requests } = adapter(() => sse(true));
  const tools = { lookup: tool({ inputSchema: z.object({}) }) };
  const first = streamText({ model, prompt: "Look it up", tools, maxRetries: 0 });
  expect((await first.toolCalls)[0]?.toolName).toBe("lookup");
  const messages = (await first.response).messages;
  const next = streamText({ model, tools, messages: [
    { role: "user", content: "Look it up" }, ...messages,
    { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", toolName: "lookup", output: { type: "text", value: "result" } }] },
  ], maxRetries: 0 });
  await next.toolCalls;
  const input = requests[1]?.input as Array<{ type: string }>;
  expect(input.some((item) => item.type === "function_call")).toBe(true);
  expect(input.some((item) => item.type === "function_call_output")).toBe(true);
  expect(input.some((item) => item.type === "item_reference")).toBe(false);
});

test("generateText and real compaction consume Codex SSE rather than requesting nonstreaming", async () => {
  const { model, requests } = adapter();
  expect((await generateText({ model, prompt: "Summarize", maxRetries: 0 })).text).toBe("Summary");
  const result = await compactWorkingContext({
    rawWorkingMessages: Array.from({ length: 14 }, (_, index) => ({ id: String(index), role: index % 2 ? "assistant" as const : "user" as const, parts: [{ type: "text" as const, text: "History" }] })),
    pinnedMessageIds: [], previousSummary: null, summarizerModel: model,
  });
  expect(result.summary).toBe("Summary");
  expect(result.droppedCount).toBe(4);
  expect(result.usage?.inputTokens).toBe(10);
  expect(requests).toHaveLength(2);
  expect(String(requests[1]?.instructions)).toContain("summarizing");
});

test("upstream HTTP errors and failed SSE never expose raw bodies or fall back", async () => {
  for (const response of [() => new Response("raw-secret", { status: 401 }), () => new Response(event({ type: "response.failed", response: { error: { message: "raw-secret" } } }))]) {
    const { model, requests } = adapter(response);
    try { await generateText({ model, prompt: "Hi", maxRetries: 0 }); throw new Error("unexpected success"); }
    catch (error) { expect(String(error)).not.toContain("raw-secret"); expect(String(error)).toContain("ChatGPT"); }
    expect(requests).toHaveLength(1);
  }
});

test("truncated summary stream fails instead of saving an empty digest", async () => {
  const { model } = adapter(() => new Response(event({ type: "response.created", response: { id: "resp_1", model: "gpt-5.4", created_at: 1 } })));
  await expect(generateText({ model, prompt: "Hi", maxRetries: 0 })).rejects.toThrow("before completion");
});
