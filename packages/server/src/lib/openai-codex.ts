import { createOpenAI } from "@ai-sdk/openai";
import {
  OPENAI_OAUTH_TOKEN_HEADER, OPENAI_OAUTH_ACCOUNT_ID_HEADER,
  isOAuthHeaderValue, type OpenAIOAuthCredentials,
} from "@darkcode/shared";

export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

export class OpenAIOAuthRequiredError extends Error {
  constructor() {
    super("ChatGPT connection missing or invalid. Connect or reconnect ChatGPT via /keys.");
  }
}

export function readOpenAIOAuthHeaders(headers: Headers): OpenAIOAuthCredentials | undefined {
  const accessToken = headers.get(OPENAI_OAUTH_TOKEN_HEADER);
  const accountId = headers.get(OPENAI_OAUTH_ACCOUNT_ID_HEADER);
  if (!accessToken && !accountId) return undefined;
  if (!isOAuthHeaderValue(accessToken) || !isOAuthHeaderValue(accountId)) throw new OpenAIOAuthRequiredError();
  return { accessToken, accountId };
}

export function createCodexModel(credentials: OpenAIOAuthCredentials | undefined, transport: typeof globalThis.fetch = globalThis.fetch) {
  if (!credentials || !isOAuthHeaderValue(credentials.accessToken) || !isOAuthHeaderValue(credentials.accountId)) {
    throw new OpenAIOAuthRequiredError();
  }
  const codexFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== CODEX_RESPONSES_URL || typeof init?.body !== "string") throw new Error("Invalid Codex request.");
    const body = JSON.parse(init.body);
    const streaming = body.stream === true;
    body.stream = true;
    body.store = false;
    body.instructions ??= "You are a helpful coding assistant.";
    for (const key of ["max_output_tokens", "temperature", "top_p", "frequency_penalty", "presence_penalty", "previous_response_id", "truncation", "user", "service_tier"]) delete body[key];
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${credentials.accessToken}`);
    headers.set("ChatGPT-Account-Id", credentials.accountId);
    headers.set("originator", "darkcode");
    let response: Response;
    try {
      response = await transport(CODEX_RESPONSES_URL, { ...init, headers, body: JSON.stringify(body), redirect: "error" });
    } catch {
      throw new Error("ChatGPT request failed. Check your connection or reconnect via /keys.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      return Response.json({ error: { message: `ChatGPT request refused (HTTP ${response.status}). Reconnect via /keys if authorization expired.` } }, { status: response.status });
    }
    // Never expose upstream error bodies/events to clients or telemetry.
    let pending = "";
    let completed = false;
    const safeBody = response.body?.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream<string, string>({
      transform(chunk, controller) {
        pending += chunk;
        if (pending.length > 8_000_000) throw new Error("ChatGPT response exceeded the size limit.");
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end).trimEnd();
          pending = pending.slice(end + 1);
          if (line.startsWith("data:") && line.slice(5).trim() !== "[DONE]") {
            try {
              const event = JSON.parse(line.slice(5));
              if (["response.completed", "response.incomplete"].includes(event.type)) completed = true;
              if (["error", "response.failed"].includes(event.type) || event.response?.error) {
                throw new Error("upstream error");
              }
            } catch { throw new Error("ChatGPT could not complete the response. Reconnect via /keys if needed."); }
          }
          controller.enqueue(`${line}\n`);
        }
      },
      flush() {
        if (pending.trim() || !completed) throw new Error("ChatGPT stream ended before completion.");
      },
    })).pipeThrough(new TextEncoderStream());
    response = new Response(safeBody, { headers: { "Content-Type": "text/event-stream" } });
    if (streaming) return response;
    // Codex only serves SSE. The SDK's generateText path expects the completed
    // Responses object as JSON, including usage (used by context compaction).
    if (!response.body) throw new Error("ChatGPT returned an empty response.");
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        if (buffer.length > 8_000_000) throw new Error("ChatGPT response exceeded the size limit.");
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).trimEnd();
          buffer = buffer.slice(end + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          const event = JSON.parse(data);
          if (event.type === "response.completed") return Response.json(event.response);
          if (["error", "response.failed", "response.incomplete"].includes(event.type)) throw new Error("ChatGPT could not complete the response.");
        }
      }
      throw new Error("ChatGPT stream ended before completion.");
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  };
  const model = createOpenAI({
    apiKey: "oauth-not-an-api-key",
    baseURL: "https://chatgpt.com/backend-api/codex",
    fetch: codexFetch as typeof fetch,
  }).responses("gpt-5.4");
  // Set store=false before SDK prompt conversion too, so tool continuations
  // contain full items instead of references to non-persisted response IDs.
  const prepare = (options: Parameters<typeof model.doGenerate>[0]) => ({
    ...options,
    prompt: options.prompt.filter((message) => message.role !== "system"),
    providerOptions: { ...options.providerOptions, openai: {
      ...options.providerOptions?.openai, store: false,
      instructions: options.prompt.filter((message) => message.role === "system").map((message) => message.content).join("\n\n") || "You are a helpful coding assistant.",
    } },
  });
  const generate = model.doGenerate.bind(model);
  const stream = model.doStream.bind(model);
  model.doGenerate = (options) => generate(prepare(options));
  model.doStream = (options) => stream(prepare(options));
  return model;
}
