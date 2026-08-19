/**
 * "Are you on the latest DarkCode?" check.
 *
 * Displaying {@link VERSION} alone doesn't answer that question, so this
 * resolves the newest published tag from the GitHub Releases API — the same
 * source `scripts/install.sh` pulls binaries from — and compares it to the
 * running build.
 *
 * Everything here is best effort and non-fatal: a rate-limited, offline, or
 * malformed response yields "no update known" rather than an error the user
 * has to care about. The answer is cached on disk for a day so we make at most
 * one request per machine per day no matter how often the CLI is launched.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { VERSION } from "./version";

const CONFIG_DIR = join(homedir(), ".darkcode");
const CACHE_FILE = join(CONFIG_DIR, "update-check.json");

/** One check per day is plenty for a tool people launch many times a day. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Never let a slow/hanging API keep the check pending for a whole session. */
const REQUEST_TIMEOUT_MS = 3_000;

const REPO = process.env.DARKCODE_REPO ?? "vufhq/darkcode";

export type UpdateStatus = {
  /** The running build, as displayed ("dev" for unreleased source runs). */
  current: string;
  /** Newest published release, or null when it couldn't be determined. */
  latest: string | null;
  /** True only when `latest` is known AND strictly newer than `current`. */
  updateAvailable: boolean;
};

type CacheEntry = {
  checkedAt: number;
  latest: string;
};

/** Strips the `v` prefix carried by release tags (`v1.2.3` → `1.2.3`). */
function normalize(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/**
 * Ordering comparison for dotted numeric versions: negative when `a` is older
 * than `b`, positive when newer, 0 when equal.
 *
 * Deliberately simple — release tags are plain `vX.Y.Z`. A pre-release suffix
 * (`1.2.3-rc.1`) compares as its numeric core, so an rc and its final release
 * tie rather than one falsely appearing newer. Non-numeric segments count as 0.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) =>
    normalize(version)
      .split("-")[0]!
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);

  const left = parse(a);
  const right = parse(b);

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True when `latest` is a release the running build predates. */
export function isUpdateAvailable(current: string, latest: string | null): boolean {
  // "dev" (source/unreleased runs) is never "behind" — a dev tree is usually
  // ahead of the last tag, and nagging it to upgrade would be noise.
  if (!latest || current === "dev") return false;
  return compareVersions(current, latest) < 0;
}

function readCache(): CacheEntry | null {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Partial<CacheEntry>;
    if (typeof parsed.latest !== "string" || typeof parsed.checkedAt !== "number") {
      return null;
    }
    if (Date.now() - parsed.checkedAt > CACHE_TTL_MS) return null;
    return { checkedAt: parsed.checkedAt, latest: parsed.latest };
  } catch {
    return null;
  }
}

function writeCache(latest: string) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(
      CACHE_FILE,
      JSON.stringify({ checkedAt: Date.now(), latest } satisfies CacheEntry),
      "utf8",
    );
  } catch {
    // A cache we can't write just means we ask again next launch.
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;

    const data = (await response.json()) as { tag_name?: unknown };
    if (typeof data.tag_name !== "string" || !data.tag_name) return null;

    return normalize(data.tag_name);
  } catch {
    // Offline, rate limited, timed out, or unparseable — all "don't know".
    return null;
  }
}

/**
 * Resolves the current-vs-latest picture, hitting the network at most once a
 * day. Resolves rather than rejects on every failure path.
 */
export async function checkForUpdate(): Promise<UpdateStatus> {
  const current = VERSION;

  const cached = readCache();
  if (cached) {
    return {
      current,
      latest: cached.latest,
      updateAvailable: isUpdateAvailable(current, cached.latest),
    };
  }

  const latest = await fetchLatestVersion();
  if (latest) writeCache(latest);

  return { current, latest, updateAvailable: isUpdateAvailable(current, latest) };
}
