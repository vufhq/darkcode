import { apiClient } from "./api-client";

// Last-known credit balance for the status-bar gauge. We deliberately model
// "couldn't load" as its own state instead of coercing a failed fetch to 0:
// showing 0 to a paid customer during a Polar/network blip looks like "you're
// broke" and is exactly the churn-driving bug class this gauge exists to make
// visible rather than hide (see MONETIZATION.md Tier 1, item 1).
export type CreditsState =
  | { status: "ok"; credits: number }
  | { status: "unavailable" };

export async function fetchCreditsBalance(): Promise<CreditsState> {
  try {
    const response = await apiClient.billing.balance.$get();
    if (!response.ok) {
      return { status: "unavailable" };
    }
    const data = await response.json();
    const credits = Number(data.credits);
    if (!Number.isFinite(credits)) {
      return { status: "unavailable" };
    }
    return { status: "ok", credits };
  } catch {
    // Network error / server unreachable — same "unavailable", never 0.
    return { status: "unavailable" };
  }
}
