/**
 * Runtime configuration for the CLI.
 *
 * The shipped single-file binary bakes in only the production API URL. Every
 * other server-coupled value (the public Clerk OAuth params) is fetched from
 * the API at login time via `GET /auth/config`, so rotating Clerk never
 * requires a CLI rebuild.
 *
 * All values are overridable by environment variables for local development:
 * `bun run dev:cli` (and the `bun link`-ed `bin/darkcode`, which loads the
 * repo `.env`) point `API_URL` at `http://localhost:3000`. When no env is set
 * — i.e. the distributed binary on an end user's machine — the baked-in
 * production default is used.
 */

/** Production API origin. Baked into the distributed binary. */
const DEFAULT_API_URL = "https://api.darkcode.sh";

/**
 * The API origin the CLI talks to. `DARKCODE_API_URL` is the public-facing
 * name (matches the website's `VITE_DARKCODE_API_URL`); `API_URL` is accepted
 * for backward compatibility with the existing dev `.env`. Trailing slashes
 * are stripped so callers can safely template `${API_URL}/path`.
 */
export const API_URL = (
  process.env.DARKCODE_API_URL ??
  process.env.API_URL ??
  DEFAULT_API_URL
).replace(/\/+$/, "");

/** True when pointed at a local dev server rather than production. */
export const isLocalApi = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(API_URL);
