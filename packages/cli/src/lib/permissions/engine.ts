import { classifyBash } from "./bash-classifier";
import { classifyFsWrite } from "./path-guards";
import { classifyMcpCall } from "./mcp-classifier";
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

// Session-wide permission posture, set from the UI layer via the
// prompt-config provider. `normal` runs the full policy + prompt flow.
// `auto-edit` skips the prompt for fs writes (still logged) but keeps bash
// and MCP gated. `yolo` auto-allows everything — logged loudly.
export type PermissionPosture = "normal" | "auto-edit" | "yolo";

let posture: PermissionPosture = "normal";

export function setPermissionPosture(next: PermissionPosture): void {
  posture = next;
}

export function getPermissionPosture(): PermissionPosture {
  return posture;
}

async function ask(req: PermissionRequest): Promise<UserResponse> {
  if (!promptHandler) {
    return { decision: "deny" };
  }
  return promptHandler(req);
}

type BashOp = { kind: "bash"; command: string };
type FsWriteOp = { kind: "fs"; projectRelativePath: string };
type McpCallOp = { kind: "mcp"; toolName: string; args?: unknown };
export type GuardedOp = BashOp | FsWriteOp | McpCallOp;

// Classify an operation against the loaded policy. Does not consult the
// user — the engine wraps this with the prompt flow.
function classify(op: GuardedOp): DecisionOutcome {
  const policy = loadPolicy();
  if (op.kind === "bash") return classifyBash(op.command, policy.bash);
  if (op.kind === "mcp") return classifyMcpCall(op.toolName, policy.mcp);
  return classifyFsWrite(op.projectRelativePath, policy.fs);
}

function summary(op: GuardedOp): string {
  if (op.kind === "bash") return op.command;
  if (op.kind === "mcp") return op.toolName;
  return op.projectRelativePath;
}

function toolName(op: GuardedOp): string {
  if (op.kind === "bash") return "bash";
  if (op.kind === "mcp") return op.toolName;
  return "fs.write";
}

// Persist an "allow always" decision as a new rule on the appropriate list.
// For bash we save the exact command (no `**`) — the user can broaden it
// later by hand-editing the file. For MCP we save the exact tool name so
// "allow create_issue" doesn't accidentally also allow "delete_issue".
function persistAllowAlways(op: GuardedOp): void {
  if (op.kind === "bash") {
    addProjectRule({ category: "bash", list: "allow", pattern: op.command });
  } else if (op.kind === "mcp") {
    addProjectRule({ category: "mcp", list: "allow", pattern: op.toolName });
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
  // Posture short-circuits, evaluated before the policy. `yolo` is the
  // explicit override and auto-allows side effects — but never the fs
  // `denyWrite` list (.env, *.pem, **/.ssh/**, …). Overwriting secrets or SSH
  // keys is never what a user means by "yolo", so those still hard-deny. The
  // decision is recorded either way so the audit trail isn't silent.
  if (posture === "yolo") {
    if (op.kind === "fs") {
      const outcome = classify(op);
      if (outcome.decision === "deny") {
        writeAudit(toolName(op), summary(op), outcome);
        throw new PermissionDeniedError(toolName(op), summary(op), outcome.reason);
      }
    }
    writeAudit(toolName(op), summary(op), {
      decision: "allow",
      reason: "yolo posture: auto-allowed",
      matchedRule: "",
    });
    return;
  }
  if (posture === "auto-edit" && op.kind === "fs") {
    // auto-edit skips the *prompt* for fs writes, but must still honour the
    // denyWrite list (.env, *.pem, **/.ssh/**, …). Classify first and refuse
    // denied paths; only auto-allow writes the policy wouldn't have blocked.
    const outcome = classify(op);
    if (outcome.decision === "deny") {
      writeAudit(toolName(op), summary(op), outcome);
      throw new PermissionDeniedError(toolName(op), summary(op), outcome.reason);
    }
    writeAudit(toolName(op), summary(op), {
      decision: "allow",
      reason: "auto-edit posture: fs write auto-allowed",
      matchedRule: outcome.matchedRule,
    });
    return;
  }

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
