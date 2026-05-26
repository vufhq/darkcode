import { classifyBash } from "./bash-classifier";
import { classifyFsWrite } from "./path-guards";
import { addProjectRule, loadPolicy } from "./policy";
import { writeAudit } from "./audit";
import type {
  DecisionOutcome,
  PermissionRequest,
  UserResponse,
} from "./types";

// React-to-imperative bridge. The dialog provider registers a handler at
// mount time; engine.checkPermission awaits the user's response via a
// Promise. When no handler is registered (headless / test), we default to
// deny so a missing UI can never silently allow a side effect.
type PromptHandler = (req: PermissionRequest) => Promise<UserResponse>;

let promptHandler: PromptHandler | null = null;

export function registerPermissionPrompt(handler: PromptHandler): () => void {
  promptHandler = handler;
  return () => {
    if (promptHandler === handler) promptHandler = null;
  };
}

async function ask(req: PermissionRequest): Promise<UserResponse> {
  if (!promptHandler) {
    return { decision: "deny" };
  }
  return promptHandler(req);
}

type BashOp = { kind: "bash"; command: string };
type FsWriteOp = { kind: "fs"; projectRelativePath: string };
export type GuardedOp = BashOp | FsWriteOp;

// Classify an operation against the loaded policy. Does not consult the
// user — the engine wraps this with the prompt flow.
function classify(op: GuardedOp): DecisionOutcome {
  const policy = loadPolicy();
  if (op.kind === "bash") return classifyBash(op.command, policy.bash);
  return classifyFsWrite(op.projectRelativePath, policy.fs);
}

function summary(op: GuardedOp): string {
  return op.kind === "bash" ? op.command : op.projectRelativePath;
}

function toolName(op: GuardedOp): string {
  return op.kind === "bash" ? "bash" : "fs.write";
}

// Persist an "allow always" decision as a new rule on the appropriate list.
// For bash we save the exact command (no `**`) — the user can broaden it
// later by hand-editing the file.
function persistAllowAlways(op: GuardedOp): void {
  if (op.kind === "bash") {
    addProjectRule({ category: "bash", list: "allow", pattern: op.command });
  } else {
    addProjectRule({
      category: "fs",
      list: "allowWrite",
      pattern: op.projectRelativePath,
    });
  }
}

// The single entry point used by local-tools.ts. Returns when the op is
// allowed; throws on deny. Audit log records the final decision either way.
export async function checkPermission(op: GuardedOp): Promise<void> {
  const outcome = classify(op);

  if (outcome.decision === "allow") {
    writeAudit(toolName(op), summary(op), outcome);
    return;
  }

  if (outcome.decision === "deny") {
    writeAudit(toolName(op), summary(op), outcome);
    throw new PermissionDeniedError(toolName(op), summary(op), outcome.reason);
  }

  // ask
  const response = await ask({
    tool: toolName(op),
    summary: summary(op),
    reason: outcome.reason,
  });

  if (response.decision === "deny") {
    const denied: DecisionOutcome = {
      decision: "deny",
      reason: "User denied",
      matchedRule: "",
    };
    writeAudit(toolName(op), summary(op), denied);
    throw new PermissionDeniedError(toolName(op), summary(op), "User denied");
  }

  if (response.decision === "allow_always") {
    persistAllowAlways(op);
  }

  const allowed: DecisionOutcome = {
    decision: "allow",
    reason:
      response.decision === "allow_always"
        ? "User approved + saved rule"
        : "User approved once",
    matchedRule: "",
  };
  writeAudit(toolName(op), summary(op), allowed);
}

export class PermissionDeniedError extends Error {
  constructor(
    public readonly tool: string,
    public readonly summary: string,
    reason: string,
  ) {
    super(`Permission denied for ${tool}: ${reason}`);
    this.name = "PermissionDeniedError";
  }
}
