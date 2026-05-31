import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import {
  RESPONSE_TOKEN_RESERVE,
  estimateMessageTokens,
  estimateMessagesTokens,
  projectNextRequestTokens,
} from "./token-estimate";

// The estimator only reads `type`/`text`/`input`/`output` off each part. The
// AI SDK's part union carries many runtime-only fields (toolCallId, state, …)
// that are irrelevant here, so we build minimal fixtures and cast once.
function message(parts: Array<Record<string, unknown>>): UIMessage {
  return { id: "m", role: "user", parts } as unknown as UIMessage;
}

describe("estimateMessageTokens", () => {
  test("counts a text part at ~4 chars/token, rounding up", () => {
    // 8 chars / 4 = 2 tokens.
    expect(estimateMessageTokens(message([{ type: "text", text: "12345678" }]))).toBe(2);
    // 9 chars -> ceil(9/4) = 3.
    expect(estimateMessageTokens(message([{ type: "text", text: "123456789" }]))).toBe(3);
  });

  test("counts a reasoning part's text", () => {
    expect(estimateMessageTokens(message([{ type: "reasoning", text: "abcd" }]))).toBe(1);
  });

  test("charges a tool part for BOTH its input args and output payload", () => {
    // input  {"a":1} -> '{"a":1}' = 7 chars -> ceil(7/4) = 2
    // output {"b":2} -> '{"b":2}' = 7 chars -> ceil(7/4) = 2
    const m = message([{ type: "tool-readFile", input: { a: 1 }, output: { b: 2 } }]);
    expect(estimateMessageTokens(m)).toBe(4);
  });

  test("handles a dynamic-tool part the same way", () => {
    const m = message([{ type: "dynamic-tool", input: { a: 1 }, output: { b: 2 } }]);
    expect(estimateMessageTokens(m)).toBe(4);
  });

  test("treats missing text as zero rather than throwing", () => {
    expect(estimateMessageTokens(message([{ type: "text" }]))).toBe(0);
  });

  test("sums multiple parts in one message", () => {
    const m = message([
      { type: "text", text: "abcd" }, // 1
      { type: "text", text: "abcdefgh" }, // 2
    ]);
    expect(estimateMessageTokens(m)).toBe(3);
  });
});

describe("estimateMessagesTokens", () => {
  test("sums across messages", () => {
    const messages = [
      message([{ type: "text", text: "abcd" }]), // 1
      message([{ type: "text", text: "abcdefgh" }]), // 2
    ];
    expect(estimateMessagesTokens(messages)).toBe(3);
  });

  test("is zero for an empty list", () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });
});

describe("projectNextRequestTokens", () => {
  test("reserves response headroom even with no content", () => {
    expect(
      projectNextRequestTokens({
        systemPrompt: "",
        workingMessages: [],
        incomingMessages: [],
      }),
    ).toBe(RESPONSE_TOKEN_RESERVE);
  });

  test("adds system prompt, working, and incoming token estimates plus the reserve", () => {
    const projected = projectNextRequestTokens({
      systemPrompt: "abcdefgh", // 8 chars -> 2
      workingMessages: [message([{ type: "text", text: "abcd" }])], // 1
      incomingMessages: [message([{ type: "text", text: "abcdefgh" }])], // 2
    });
    expect(projected).toBe(2 + 1 + 2 + RESPONSE_TOKEN_RESERVE);
  });

  test("exposes a non-trivial response reserve", () => {
    expect(RESPONSE_TOKEN_RESERVE).toBe(4096);
  });
});
