export const OPENAI_OAUTH_TOKEN_HEADER = "x-darkcode-openai-oauth-token";
export const OPENAI_OAUTH_ACCOUNT_ID_HEADER = "x-darkcode-openai-account-id";
export const CHATGPT_MODEL_ID = "chatgpt-gpt-5.4";

export type OpenAIOAuthCredentials = { accessToken: string; accountId: string };

export function isOAuthHeaderValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384 && /^[\x21-\x7e]+$/.test(value);
}

export function assertOAuthServerUrl(value: string): void {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("ChatGPT requires an HTTPS DarkCode server (HTTP is allowed only on loopback).");
  }
}
