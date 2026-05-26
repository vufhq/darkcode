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
      "cat **",
      "head **",
      "tail **",
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
  fs: {
    allowWrite: [
      // The agent's normal workspace. Project-specific paths get added by
      // the user via "allow always" in the prompt.
      "**",
    ],
    denyWrite: [
      // Common secret locations. These globs are tested against the
      // project-relative path, so a write to `./.env` is blocked.
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
  },
};
