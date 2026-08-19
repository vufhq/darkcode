/**
 * Live smoke test for the `webSearch` tool against the real Moonshot API.
 *
 * The unit tests in `packages/server/src/lib/web-search.test.ts` drive the
 * `$web_search` loop against scripted responses, which proves the protocol is
 * implemented as documented — but not that the documentation matches the API.
 * This script is the other half: one real call, one real search, one billed
 * request. It is deliberately NOT part of `bun test`, because a test suite
 * that costs money and needs network is a test suite people stop running.
 *
 * Usage:
 *
 *   MOONSHOT_API_KEY=sk-... bun run scripts/smoke-web-search.ts
 *   MOONSHOT_API_KEY=sk-... bun run scripts/smoke-web-search.ts "your query"
 *
 * Optional: MOONSHOT_BASE_URL, MOONSHOT_SEARCH_MODEL.
 */

import { webSearch } from "../packages/server/src/lib/web-search";

const apiKey = process.env.MOONSHOT_API_KEY;
if (!apiKey) {
  console.error("MOONSHOT_API_KEY is not set. This script makes a real, billed API call.");
  process.exit(1);
}

const query = process.argv[2] ?? "What is the current stable version of Bun, and when was it released?";
const baseUrl = process.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1";
const model = process.env.MOONSHOT_SEARCH_MODEL ?? "kimi-k2.6";

console.log(`model:  ${model}`);
console.log(`query:  ${query}\n`);

const started = Date.now();
try {
  const result = await webSearch(query, { apiKey, baseUrl, model });

  console.log(`rounds: ${result.rounds} search round(s) in ${Date.now() - started}ms`);
  console.log(`truncated: ${result.truncated}\n`);
  console.log("--- answer ---");
  console.log(result.answer);
  console.log("\n--- sources ---");
  console.log(result.sources.length > 0 ? result.sources.join("\n") : "(none cited)");

  // The two things most likely to be wrong if the API has moved on: the loop
  // never runs a search, or it comes back with no citations to follow.
  if (result.rounds === 0) {
    console.warn("\nWARNING: the model answered without searching. Try a query about something recent.");
  }
  if (result.sources.length === 0) {
    console.warn("\nWARNING: no source URLs in the answer — webFetch follow-up will have nothing to use.");
  }
} catch (error) {
  console.error(`\nFAILED after ${Date.now() - started}ms:`);
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
