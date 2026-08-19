import {
  SUPPORTED_CHAT_MODELS,
  findSupportedChatModel,
  type ModelPricing,
} from "@darkcode/shared";
import type { LanguageModelUsage } from "ai";

type CalculateCreditsForUsageParams = {
  provider: string;
  model: string;
  usage: LanguageModelUsage;
};

type BillableUsage = {
  credits: number;
};

type TokenCounts = {
  /** Fresh (uncached) input tokens — `inputTokens` minus any cached portion. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache. */
  cachedInputTokens: number;
};

const TOKENS_PER_MILLION = 1_000_000;
// Darkcode charges in internal credits instead of exposing provider pricing.
// We currently peg 1 credit to $0.01 so credits stay easy to reason about
// like cents, while still being granular enough for small AI usage. Change
// this constant if product wants a finer unit like 0.001 or a coarser one.
const USD_PER_CREDIT = 0.01;

function isNonNegativeInteger(value: number | undefined | null): value is number {
  return (
    value != null &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function getTokenCounts(usage: LanguageModelUsage): TokenCounts {
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;

  if (!isNonNegativeInteger(inputTokens) || !isNonNegativeInteger(outputTokens)) {
    throw new Error("Credit conversion requires input and output token counts");
  }

  // Providers report `cachedInputTokens` as a SUBSET of `inputTokens`, so the
  // fresh count is the difference. A provider that omits the field (or reports
  // something nonsensical) falls back to charging everything at the fresh rate
  // — the old behavior, and the safe direction for us rather than the user.
  const reportedCached = (usage as { cachedInputTokens?: number }).cachedInputTokens;
  const cachedInputTokens = isNonNegativeInteger(reportedCached)
    ? Math.min(reportedCached, inputTokens)
    : 0;

  return {
    inputTokens: inputTokens - cachedInputTokens,
    outputTokens,
    cachedInputTokens,
  };
};

function getModelPricing(provider: string, model: string): ModelPricing {
  const supportedModel = findSupportedChatModel(model);

  if (!supportedModel || supportedModel.provider !== provider) {
    if (!SUPPORTED_CHAT_MODELS.some((supportedModel) => supportedModel.provider === provider)) {
      throw new Error(`Unsupported billing provider: ${provider}`);
    }

    throw new Error(`Unsupported billing model: ${model}`);
  }

  return supportedModel.pricing;
};

function estimateCostUsd(
  { inputTokens, outputTokens, cachedInputTokens }: TokenCounts,
  pricing: ModelPricing,
) {
  // Cache reads cost a fraction of fresh input. Models without a published
  // cached rate bill at the fresh rate (see ModelPricing).
  const cachedRate =
    pricing.cachedInputUsdPerMillionTokens ?? pricing.inputUsdPerMillionTokens;

  return (
    (inputTokens * pricing.inputUsdPerMillionTokens +
      cachedInputTokens * cachedRate +
      outputTokens * pricing.outputUsdPerMillionTokens) /
    TOKENS_PER_MILLION
  );
};

function convertUsdToCredits(estimatedCostUsd: number) {
  if (estimatedCostUsd <= 0) {
    return 0;
  }

  // If a request costs any non-zero amount, charge at least 1 credit, then
  // round up so partial credits always become a whole credit.
  return Math.max(1, Math.ceil(estimatedCostUsd / USD_PER_CREDIT));
};


export function calculateCreditsForUsage({
  provider,
  model,
  usage,
}: CalculateCreditsForUsageParams): BillableUsage {
  const tokenCounts = getTokenCounts(usage);
  const pricing = getModelPricing(provider, model);
  const estimatedCostUsd = estimateCostUsd(tokenCounts, pricing);
  const credits = convertUsdToCredits(estimatedCostUsd);

  return {
    credits,
  };
};

// Up-front cost estimate for a turn we haven't run yet, used by the chat
// route's credit gate. The gate previously asked only "is the balance above
// zero", which let a one-credit account start a turn that costs orders of
// magnitude more — and, because nothing is reserved, let every request inside
// the rate-limit window pass the same check before any of them billed.
//
// Deliberately conservative: `projectedInputTokens` already carries a response
// reserve, and we bill the reserve at the (higher) output rate.
export function estimateCreditsForProjectedTurn({
  provider,
  model,
  projectedInputTokens,
  responseReserveTokens,
}: {
  provider: string;
  model: string;
  projectedInputTokens: number;
  responseReserveTokens: number;
}): number {
  const pricing = getModelPricing(provider, model);
  const inputTokens = Math.max(0, projectedInputTokens - responseReserveTokens);

  // Assume nothing is cached — an estimate that under-reads the cost is the
  // one that lets the overrun through.
  const estimatedCostUsd = estimateCostUsd(
    { inputTokens, outputTokens: responseReserveTokens, cachedInputTokens: 0 },
    pricing,
  );

  return convertUsdToCredits(estimatedCostUsd);
}

// ---------------------------------------------------------------------------
// Web search
// ---------------------------------------------------------------------------

/**
 * What Moonshot charges per successful `$web_search` call, in USD.
 *
 * Source: https://platform.kimi.ai/docs/pricing/tools — "$0.005, per successful
 * tool call". Hard-coded because there is no API to read it from; if Moonshot
 * changes the price, this constant is the one place to change, and
 * `scripts/smoke-web-search.ts` is the thing that will notice something moved.
 */
export const USD_PER_SEARCH = 0.005;

/**
 * Credits owed for a turn's web searches.
 *
 * Metered separately from tokens, and — unlike tokens — metered for *every*
 * user, BYOK included. The principle the rest of this file follows is that we
 * bill what runs on our infrastructure: a BYOK turn calls the user's own
 * provider account, so we don't charge for it. Search never does. It always
 * runs against DarkCode's Moonshot account, whatever model the user is
 * chatting with, so leaving it unmetered would mean BYOK users searching
 * indefinitely on our account.
 *
 * Rounded up once per turn rather than per search, which matches how token
 * billing already rounds: at $0.005 a search and $0.01 a credit, two searches
 * are exactly one credit, and a lone search costs one.
 */
export function calculateCreditsForSearchRounds(rounds: number): number {
  if (!Number.isFinite(rounds) || rounds <= 0) return 0;
  return convertUsdToCredits(Math.floor(rounds) * USD_PER_SEARCH);
}
