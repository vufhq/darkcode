import { describe, expect, test } from "bun:test";

import { classifyWebRequest, matchesHostPattern } from "./web-classifier";
import { DEFAULT_POLICY } from "./defaults";

describe("matchesHostPattern", () => {
  test("matches an exact host", () => {
    expect(matchesHostPattern("example.com", "example.com")).toBe(true);
    expect(matchesHostPattern("example.com", "example.org")).toBe(false);
  });

  test("is case-insensitive on both sides", () => {
    expect(matchesHostPattern("ExAmPle.COM", "example.com")).toBe(true);
    expect(matchesHostPattern("example.com", "EXAMPLE.com")).toBe(true);
  });

  test("`**` matches everything", () => {
    expect(matchesHostPattern("anything.at.all", "**")).toBe(true);
    expect(matchesHostPattern("localhost:3000", "**")).toBe(true);
  });

  test("`*.example.com` matches subdomains", () => {
    expect(matchesHostPattern("docs.example.com", "*.example.com")).toBe(true);
    expect(matchesHostPattern("a.b.example.com", "*.example.com")).toBe(true);
  });

  test("`*.example.com` does NOT match the bare domain", () => {
    // Matching how certificates and cookie domains are normally read — and the
    // safer direction, since a rule that silently covers more than it says is
    // the failure mode that matters for a security check.
    expect(matchesHostPattern("example.com", "*.example.com")).toBe(false);
  });

  test("a subdomain wildcard does not match a lookalike suffix", () => {
    // `notexample.com` ends with "example.com" as a string. Anchoring on the
    // dot is what stops an attacker registering `evilexample.com`.
    expect(matchesHostPattern("notexample.com", "*.example.com")).toBe(false);
    expect(matchesHostPattern("evil-example.com", "*.example.com")).toBe(false);
  });

  test("a pattern without a port matches any port", () => {
    expect(matchesHostPattern("example.com:8443", "example.com")).toBe(true);
    expect(matchesHostPattern("example.com", "example.com")).toBe(true);
  });

  test("a pattern with a port matches only that port", () => {
    expect(matchesHostPattern("localhost:3000", "localhost:3000")).toBe(true);
    expect(matchesHostPattern("localhost:9229", "localhost:3000")).toBe(false);
    expect(matchesHostPattern("localhost", "localhost:3000")).toBe(false);
  });

  test("handles bracketed IPv6 literals with and without a port", () => {
    // A naive split(":") reads "::1" as a port and matches nothing — which for
    // a deny rule means silently failing open.
    expect(matchesHostPattern("[::1]", "[::1]")).toBe(true);
    expect(matchesHostPattern("[::1]:8080", "[::1]")).toBe(true);
    expect(matchesHostPattern("[::1]:8080", "[::1]:8080")).toBe(true);
    expect(matchesHostPattern("[::1]:8080", "[::1]:9000")).toBe(false);
    expect(matchesHostPattern("[fd00:ec2::254]", "[fd00:ec2::254]")).toBe(true);
  });
});

describe("classifyWebRequest", () => {
  const rules = { allow: ["docs.example.com"], deny: ["169.254.169.254"], ask: ["**"] };

  test("deny wins over allow", () => {
    const both = { allow: ["evil.com"], deny: ["evil.com"], ask: ["**"] };
    expect(classifyWebRequest("evil.com", both).decision).toBe("deny");
  });

  test("allow wins over ask", () => {
    expect(classifyWebRequest("docs.example.com", rules).decision).toBe("allow");
  });

  test("unmatched hosts fall through to ask", () => {
    const outcome = classifyWebRequest("random.site", rules);
    expect(outcome.decision).toBe("ask");
    expect(outcome.matchedRule).toBe("**");
  });

  test("reports ask with no matched rule when nothing matches at all", () => {
    const empty = { allow: [], deny: [], ask: [] };
    const outcome = classifyWebRequest("random.site", empty);
    expect(outcome.decision).toBe("ask");
    expect(outcome.matchedRule).toBe("");
  });

  test("names the host in the reason, for the prompt and the audit log", () => {
    expect(classifyWebRequest("docs.example.com", rules).reason).toContain("docs.example.com");
  });
});

describe("default web policy", () => {
  test("asks before fetching any host", () => {
    // Nothing is pre-approved: the first fetch of a host must reach the user.
    expect(classifyWebRequest("example.com", DEFAULT_POLICY.web).decision).toBe("ask");
    expect(classifyWebRequest("localhost:5173", DEFAULT_POLICY.web).decision).toBe("ask");
  });

  test("hard-denies cloud instance-metadata endpoints", () => {
    // These hand out cloud credentials to anything on the box that asks. They
    // are the highest-value target reachable from a machine running an agent,
    // and no coding task legitimately reads one.
    for (const host of [
      "169.254.169.254",
      "metadata.google.internal",
      "metadata.goog",
      "100.100.100.200",
      "[fd00:ec2::254]",
    ]) {
      expect(classifyWebRequest(host, DEFAULT_POLICY.web).decision).toBe("deny");
    }
  });

  test("denies a metadata endpoint reached on a non-default port", () => {
    expect(classifyWebRequest("169.254.169.254:80", DEFAULT_POLICY.web).decision).toBe("deny");
  });
});
