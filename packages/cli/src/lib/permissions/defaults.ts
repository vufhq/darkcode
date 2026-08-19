import type { Policy } from "./types";

// Sensible baseline shipped with DarkCode. The first time a project needs a
// rule that isn't in this default, the user is prompted; choosing "allow
// always" writes the new rule to the project's `.darkcode/permissions.json`.
//
// Patterns use a simple glob: `*` matches one token, `**` matches the rest of
// the command. See bash-classifier.ts for the matcher.
export const DEFAULT_POLICY: Policy = {
  bash: {
    allow: [
      // Inspection — never mutates the repo or filesystem.
      "git status",
      "git status **",
      "git diff",
      "git diff **",
      "git log",
      "git log **",
      "git show **",
      "git branch",
      "git branch **",
      "git remote",
      "git remote -v",
      "ls",
      "ls **",
      "pwd",
      // NOTE: cat/head/tail are intentionally NOT auto-allowed. bash has no
      // path jail, so `cat ~/.ssh/id_rsa` or `tail ../../secret` would exfil
      // files from outside the project. These now route to a prompt; choosing
      // "allow always" saves the exact (project-local) command the user OKs.
      "wc **",
      "echo **",
      "which **",
      "node --version",
      "bun --version",
      "npm --version",
      // Read-only test/lint commands.
      "bun test",
      "bun test **",
      "npm test",
      "npm test **",
      "bunx tsc --noEmit",
      "bunx tsc --noEmit **",
    ],
    deny: [
      // Catastrophic destructive recursion.
      "rm -rf /",
      "rm -rf /*",
      "rm -rf ~",
      "rm -rf ~/**",
      "rm -rf $HOME",
      "rm -rf $HOME/**",
      // Privilege escalation.
      "sudo **",
      "su **",
      "doas **",
      // Pipe-to-shell.
      "curl ** | sh",
      "curl ** | bash",
      "wget ** | sh",
      "wget ** | bash",
      // Fork bomb shorthand. The classifier also rejects anything that
      // doesn't parse as a valid simple-command sequence.
      ":(){ :|:& };:",
    ],
    ask: [
      // Network / publish operations — non-destructive locally but visible
      // externally, so they warrant explicit consent.
      "git push",
      "git push **",
      "git pull",
      "git pull **",
      "git fetch",
      "git fetch **",
      "npm publish",
      "npm publish **",
      "bun publish",
      "bun publish **",
      "curl **",
      "wget **",
    ],
  },
  web: {
    // Nothing is pre-approved. The first fetch of a host prompts; "allow
    // always" writes that host to the project policy under `web.allow`.
    allow: [],
    // Cloud instance-metadata endpoints. These are link-local addresses that
    // hand out short-lived cloud credentials to anything on the box that asks,
    // with no authentication — they are the single most valuable target
    // reachable from a machine running an agent, and there is no legitimate
    // reason for a coding assistant to read one.
    //
    // This list is why redirects are re-checked hop by hop in web/fetch.ts: an
    // allowed host that 302s to 169.254.169.254 would otherwise walk straight
    // past a rule the user thought was protecting them.
    deny: [
      "169.254.169.254",
      "[fd00:ec2::254]",
      "metadata.google.internal",
      "metadata.goog",
      "100.100.100.200",
      "metadata.azure.com",
    ],
    ask: ["**"],
  },
  mcp: {
    // Default-ask for every MCP tool. The first call surfaces a permission
    // prompt; "allow always" writes the exact tool name to the project policy
    // under `mcp.allow`.
    allow: [],
    deny: [],
    ask: ["mcp__**"],
  },
  fs: {
    allowWrite: [
      // NOTE: this is a blanket allow — every write inside the project is
      // auto-approved, and only `denyWrite` below stops anything. That is a
      // deliberate product call (a coding agent that prompts on every edit is
      // unusable), but it means the `normal` posture differs from `auto-edit`
      // only for bash and MCP, not for file edits. Narrow this list if you
      // want per-path write prompts.
      "**",
    ],
    // Common secret locations. These globs are tested against the
    // project-relative path, so a write to `./.env` is blocked.
    denyWrite: [
      ".env",
      ".env.*",
      "**/.env",
      "**/.env.*",
      "**/*.pem",
      "**/*.key",
      "**/id_rsa",
      "**/id_ed25519",
      "**/.ssh/**",
      "**/.aws/**",
      "**/.gnupg/**",
    ],
    // Files whose contents must never be sent to the model. Reads are
    // otherwise unrestricted. Seeded from `denyWrite` — a file worth
    // protecting from being clobbered is worth protecting from exfiltration —
    // plus credential stores that are read-only in practice and so never
    // needed a write rule.
    denyRead: [
      ".env",
      ".env.*",
      "**/.env",
      "**/.env.*",
      "**/*.pem",
      "**/*.key",
      "**/*.p12",
      "**/*.pfx",
      "**/id_rsa",
      "**/id_ed25519",
      "**/id_ecdsa",
      "**/.ssh/**",
      "**/.aws/**",
      "**/.gnupg/**",
      "**/.npmrc",
      "**/.pypirc",
      "**/.netrc",
      "**/.git-credentials",
      // DarkCode's own credential files, if the project happens to sit at $HOME.
      "**/.darkcode/auth.json",
      "**/.darkcode/api-keys.json",
    ],
  },
};
