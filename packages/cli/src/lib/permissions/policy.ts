import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_POLICY } from "./defaults";
import type { Policy } from "./types";

const GLOBAL_DIR = join(homedir(), ".darkcode");
const GLOBAL_FILE = join(GLOBAL_DIR, "permissions.json");

function projectFile(cwd: string): string {
  return join(cwd, ".darkcode", "permissions.json");
}

type PartialPolicy = {
  bash?: Partial<Policy["bash"]>;
  fs?: Partial<Policy["fs"]>;
};

function readJson(path: string): PartialPolicy | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as PartialPolicy;
  } catch {
    // Missing or malformed — treat as absent. The defaults still apply.
  }
  return null;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function mergeLayer(base: Policy, overlay: PartialPolicy | null): Policy {
  if (!overlay) return base;
  return {
    bash: {
      allow: dedupe([...base.bash.allow, ...(overlay.bash?.allow ?? [])]),
      deny: dedupe([...base.bash.deny, ...(overlay.bash?.deny ?? [])]),
      ask: dedupe([...base.bash.ask, ...(overlay.bash?.ask ?? [])]),
    },
    fs: {
      allowWrite: dedupe([
        ...base.fs.allowWrite,
        ...(overlay.fs?.allowWrite ?? []),
      ]),
      denyWrite: dedupe([...base.fs.denyWrite, ...(overlay.fs?.denyWrite ?? [])]),
    },
  };
}

// Load the effective policy: defaults < global < project. Higher layers add
// to lower layers; nothing is removed via layering (use a manual edit to
// drop a rule). The result is cached per-process; call `invalidatePolicy()`
// after writing a new rule.
let cached: Policy | null = null;
let cachedCwd: string | null = null;

export function loadPolicy(cwd: string = process.cwd()): Policy {
  if (cached && cachedCwd === cwd) return cached;
  const global = readJson(GLOBAL_FILE);
  const project = readJson(projectFile(cwd));
  cached = mergeLayer(mergeLayer(DEFAULT_POLICY, global), project);
  cachedCwd = cwd;
  return cached;
}

export function invalidatePolicy(): void {
  cached = null;
  cachedCwd = null;
}

type BashList = keyof Policy["bash"];
type FsList = keyof Policy["fs"];

type AddRuleArgs =
  | { category: "bash"; list: BashList; pattern: string }
  | { category: "fs"; list: FsList; pattern: string };

// Append a rule to the project-level policy file. Creates the file (and
// `.darkcode/`) on first use. The project file is intentionally local —
// the user can decide whether to commit it.
export function addProjectRule(args: AddRuleArgs, cwd: string = process.cwd()): void {
  const path = projectFile(cwd);
  const existing = readJson(path) ?? {};

  if (args.category === "bash") {
    const bash = { ...(existing.bash ?? {}) };
    const current = bash[args.list] ?? [];
    if (!current.includes(args.pattern)) {
      bash[args.list] = [...current, args.pattern];
    }
    existing.bash = bash;
  } else {
    const fs = { ...(existing.fs ?? {}) };
    const current = fs[args.list] ?? [];
    if (!current.includes(args.pattern)) {
      fs[args.list] = [...current, args.pattern];
    }
    existing.fs = fs;
  }

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(existing, null, 2));
  invalidatePolicy();
}
