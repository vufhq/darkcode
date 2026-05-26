import { createClerkClient } from "@clerk/backend";
import { env } from "./env";

const clerkClient = createClerkClient({
  secretKey: env.CLERK_SECRET_KEY,
  publishableKey: env.CLERK_PUBLISHABLE_KEY,
});

export async function authenticateOAuthRequest(request: Request) {
  // Accept both Clerk OAuth tokens (used by the CLI's device-code flow) and
  // session JWTs (used by the website's @clerk/clerk-react SDK). The two
  // surfaces share the same Clerk user, so userId resolution is identical.
  const requestState = await clerkClient.authenticateRequest(request, {
    acceptsToken: ["oauth_token", "session_token"],
  });

  if (!requestState.isAuthenticated) {
    return null;
  }

  const auth = requestState.toAuth();
  if (!auth.userId) {
    return null;
  }

  return { userId: auth.userId };
}
