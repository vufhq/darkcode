import { describe, expect, test } from "bun:test";
import { parseChatError, formatChatErrorMessage } from "./http-errors";

describe("parseChatError", () => {
  test("unwraps the error field from a JSON body", () => {
    const { message } = parseChatError('{"error":"No credits remaining."}');
    expect(message).toBe("No credits remaining.");
  });

  test("lifts a machine-readable code when present", () => {
    const { message, code } = parseChatError(
      '{"error":"No credits remaining. Run /upgrade to buy more credits.","code":"credits_depleted"}',
    );
    expect(message).toBe("No credits remaining. Run /upgrade to buy more credits.");
    expect(code).toBe("credits_depleted");
  });

  test("code is undefined when the body omits it", () => {
    expect(parseChatError('{"error":"boom"}').code).toBeUndefined();
  });

  test("falls back to the raw string for non-JSON bodies", () => {
    const { message, code } = parseChatError("plain text failure");
    expect(message).toBe("plain text failure");
    expect(code).toBeUndefined();
  });

  test("collapses to the first line", () => {
    expect(parseChatError("line one\nline two").message).toBe("line one");
  });

  test("caps an over-long message at 600 chars + ellipsis", () => {
    const { message } = parseChatError("x".repeat(900));
    expect(message.length).toBe(601);
    expect(message.endsWith("…")).toBe(true);
  });

  test("ignores malformed JSON and uses the raw string", () => {
    expect(parseChatError('{"error": oops').message).toBe('{"error": oops');
  });
});

describe("formatChatErrorMessage (back-compat wrapper)", () => {
  test("returns just the display message, dropping the code", () => {
    expect(
      formatChatErrorMessage('{"error":"nope","code":"credits_depleted"}'),
    ).toBe("nope");
  });
});
