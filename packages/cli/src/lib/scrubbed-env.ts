// Credential-bearing env vars stripped before we hand the environment to a
// child process we don't fully trust — the `bash` tool and MCP servers. The
// goal is containment, not perfect isolation: a child cannot inherit the
// user's cloud / SSH / npm tokens unless they live in the project's own files
// or are explicitly re-exported. PATH/HOME/USER/SHELL/LANG are preserved so
// ordinary commands still resolve and run.
//
// Names are matched case-insensitively: a non-standard lowercase `github_token`
// is just as sensitive as `GITHUB_TOKEN`.
const CREDENTIAL_ENV_DENYLIST = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "MOONSHOT_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GCP_SERVICE_ACCOUNT_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AZURE_CLIENT_SECRET",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "POLAR_ACCESS_TOKEN",
  "CLERK_SECRET_KEY",
  "DATABASE_URL",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
]);

const CREDENTIAL_ENV_PATTERN_DENYLIST = [
  /^.*_API_KEY$/i,
  /^.*_TOKEN$/i,
  /^.*_SECRET$/i,
  /^.*_PASSWORD$/i,
  /^.*_PASSWD$/i,
];

/**
 * Copy `process.env` minus any credential-bearing variable. Shared by the
 * `bash` tool and the MCP host so both spawn paths get the same containment.
 */
export function scrubCredentialEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    if (CREDENTIAL_ENV_DENYLIST.has(key.toUpperCase())) continue;
    if (CREDENTIAL_ENV_PATTERN_DENYLIST.some((re) => re.test(key))) continue;
    out[key] = value;
  }
  return out;
}

/** Scrubbed env for the `bash` tool, with `TERM=dumb` to keep output plain. */
export function scrubbedBashEnv(): Record<string, string> {
  const out = scrubCredentialEnv();
  out.TERM = "dumb";
  return out;
}
