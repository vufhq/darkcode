import open from "open";
import { apiClient } from "./api-client";
import { getErrorMessage } from "./http-errors";

export async function openUpgradeCheckout() {
  const response = await apiClient.billing.checkout.$post();

  if (response.ok) {
    const data = await response.json();
    await open(data.url);
    return;
  }

  throw new Error(await getErrorMessage(response));
};

// Opens the Pro subscription checkout. The server 503s with code
// "pro_unavailable" when Pro isn't provisioned for this environment — the
// human message surfaces to the user via the toast.
export async function openProCheckout() {
  const response = await apiClient.billing.checkout.pro.$post();

  if (response.ok) {
    const data = await response.json();
    await open(data.url);
    return;
  }

  throw new Error(await getErrorMessage(response));
};

export async function openBillingPortal() {
  const response = await apiClient.billing.portal.$post();

  if (response.ok) {
    const data = await response.json();
    await open(data.url);
    return;
  }

  throw new Error(await getErrorMessage(response));
};
