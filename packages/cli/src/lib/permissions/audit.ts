import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DecisionOutcome } from "./types";

const CONFIG_DIR = join(homedir(), ".darkcode");
const AUDIT_FILE = join(CONFIG_DIR, "audit.jsonl");

export type AuditEntry = {
  ts: string;
  tool: string;
  summary: string;
  decision: DecisionOutcome["decision"];
  reason: string;
  matchedRule: string;
};

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    // Owner-only so other users can't read the audit trail.
    mkdirSync(CONFIG_DIR, { mode: 0o700 });
  }
}

export function writeAudit(
  tool: string,
  summary: string,
  outcome: DecisionOutcome,
): void {
  try {
    ensureConfigDir();
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      tool,
      summary,
      decision: outcome.decision,
      reason: outcome.reason,
      matchedRule: outcome.matchedRule,
    };
    appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch {
    // Audit failures must never break tool execution. Swallow and continue.
  }
}

// Read the most recent entries from the audit log. Returns an empty array if
// the file doesn't exist yet. Loads the whole file and slices — the log is
// JSONL and stays small in practice; rotation can come later.
export function readRecentAudit(limit = 50): AuditEntry[] {
  try {
    const raw = readFileSync(AUDIT_FILE, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const tail = lines.slice(-limit);
    const entries: AuditEntry[] = [];
    for (const line of tail) {
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // Skip malformed lines rather than failing the viewer.
      }
    }
    return entries.reverse();
  } catch {
    return [];
  }
}
