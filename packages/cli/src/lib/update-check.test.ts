import { describe, expect, test } from "bun:test";

import { compareVersions, isUpdateAvailable } from "./update-check";

describe("compareVersions", () => {
  test("orders by each numeric segment", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareVersions("1.3.0", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  test("ignores a `v` prefix on either side", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "v1.3.0")).toBeLessThan(0);
  });

  test("treats missing trailing segments as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBeLessThan(0);
  });

  test("compares a pre-release by its numeric core, so it ties its release", () => {
    // Deliberate: an rc must not read as *newer* than the final tag, which is
    // the only direction that would produce a bogus 'update available'.
    expect(compareVersions("1.3.0-rc.1", "1.3.0")).toBe(0);
    expect(compareVersions("1.3.0-rc.1", "1.2.9")).toBeGreaterThan(0);
  });

  test("does not fall for lexicographic ordering", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });
});

describe("isUpdateAvailable", () => {
  test("is true only when the running build predates the latest release", () => {
    expect(isUpdateAvailable("1.2.3", "1.3.0")).toBe(true);
    expect(isUpdateAvailable("1.3.0", "1.3.0")).toBe(false);
    // A build ahead of the last published tag isn't behind anything.
    expect(isUpdateAvailable("1.4.0", "1.3.0")).toBe(false);
  });

  test("is false when the latest release is unknown", () => {
    expect(isUpdateAvailable("1.2.3", null)).toBe(false);
  });

  test("never nags a dev build", () => {
    expect(isUpdateAvailable("dev", "9.9.9")).toBe(false);
  });
});
