import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Mode } from "@darkcode/shared";
import { executeLocalTool } from "./local-tools";
import * as audit from "./permissions/audit";
import { getPermissionPosture, PermissionDeniedError, setPermissionPosture } from "./permissions/engine";
import { invalidatePolicy } from "./permissions/policy";

test("local tools protect OAuth tokens from home and .darkcode working directories", async () => {
  const originalCwd = process.cwd();
  const originalPosture = getPermissionPosture();
  const root = mkdtempSync(join(tmpdir(), "darkcode-oauth-guards-"));
  const directory = join(root, ".darkcode");
  const names = ["openai-oauth.json", "openai-oauth.json.0123456789abcdef.tmp"];
  const secret = "oauth-secret-sentinel";
  const auditSpy = spyOn(audit, "writeAudit").mockImplementation(() => {});
  try {
    mkdirSync(directory);
    for (const name of names) writeFileSync(join(directory, name), secret);
    for (const cwd of [root, directory]) {
      process.chdir(cwd);
      invalidatePolicy();
      for (const posture of ["normal", "auto-edit", "yolo"] as const) {
        setPermissionPosture(posture);
        for (const name of names) {
          const absolute = join(directory, name);
          for (const path of [relative(cwd, absolute), absolute]) {
            for (const [tool, input] of [
              ["readFile", { path }],
              ["writeFile", { path, content: "replacement" }],
              ["editFile", { path, oldString: secret, newString: "replacement" }],
              ["lspDefinition", { path, line: 0, character: 0 }],
              ["lspReferences", { path, line: 0, character: 0 }],
              ["lspHover", { path, line: 0, character: 0 }],
              ["lspDiagnostics", { path }],
              ["lspSymbols", { path }],
            ] as const) {
              await expect(executeLocalTool(tool, input, Mode.BUILD, "oauth-guards"))
                .rejects.toBeInstanceOf(PermissionDeniedError);
            }
          }
          expect(readFileSync(absolute, "utf8")).toBe(secret);
        }
        const result = await executeLocalTool("grep", {
          path: directory, pattern: secret,
        }, Mode.PLAN, "oauth-guards");
        expect(result).toMatchObject({ matches: [], skippedProtectedFiles: 2 });
        expect(JSON.stringify(result)).not.toContain(secret);
      }
    }
  } finally {
    process.chdir(originalCwd);
    setPermissionPosture(originalPosture);
    invalidatePolicy();
    auditSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
