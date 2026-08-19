import type { DecisionOutcome, WebRules } from "./types";

/**
 * Pattern matcher for web hosts.
 *
 * Patterns are matched against the URL's host, lowercased:
 *
 *   `**`               matches any host
 *   `example.com`      exact host only
 *   `*.example.com`    any subdomain — but NOT `example.com` itself, matching
 *                      how certificates and cookie domains are normally read
 *   `localhost:3000`   host with an explicit port
 *
 * A pattern without a port matches the host on any port; a pattern *with* one
 * matches only that port. That asymmetry is deliberate: "let it talk to
 * example.com" is a statement about a site, while "let it talk to
 * localhost:3000" is a statement about one specific local service, and the
 * whole reason to name a port is to exclude the others.
 */
export function matchesHostPattern(host: string, pattern: string): boolean {
  const value = host.toLowerCase();
  const rule = pattern.trim().toLowerCase();
  if (rule === "**" || rule === "*") return true;

  const [valueHost = "", valuePort = ""] = splitHostPort(value);
  const [ruleHost = "", rulePort = ""] = splitHostPort(rule);

  if (rulePort !== "" && rulePort !== valuePort) return false;

  if (ruleHost.startsWith("*.")) {
    const suffix = ruleHost.slice(1); // ".example.com"
    return valueHost.endsWith(suffix) && valueHost.length > suffix.length;
  }
  return ruleHost === valueHost;
}

/**
 * Split `host[:port]`, leaving bracketed IPv6 literals intact.
 *
 * `[::1]:8080` has colons inside the host, so a naive `split(":")` would
 * mistake `::1` for a port and silently fail to match any rule — which for a
 * security check means falling through to a decision the user did not intend.
 */
function splitHostPort(value: string): [string, string] {
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close === -1) return [value, ""];
    const rest = value.slice(close + 1);
    return [value.slice(0, close + 1), rest.startsWith(":") ? rest.slice(1) : ""];
  }
  const colon = value.lastIndexOf(":");
  if (colon === -1) return [value, ""];
  return [value.slice(0, colon), value.slice(colon + 1)];
}

function firstMatch(host: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    if (matchesHostPattern(host, pattern)) return pattern;
  }
  return null;
}

/**
 * Classify a web request against the loaded policy. Deny wins over allow,
 * allow over ask, and anything unmatched falls through to ask.
 */
export function classifyWebRequest(host: string, rules: WebRules): DecisionOutcome {
  const denied = firstMatch(host, rules.deny);
  if (denied) {
    return {
      decision: "deny",
      reason: `Host "${host}" matches deny rule`,
      matchedRule: denied,
    };
  }

  const allowed = firstMatch(host, rules.allow);
  if (allowed) {
    return {
      decision: "allow",
      reason: `Host "${host}" matches allow rule`,
      matchedRule: allowed,
    };
  }

  const asked = firstMatch(host, rules.ask);
  return {
    decision: "ask",
    reason: asked ? `Host "${host}" matches ask rule` : `Host "${host}" has no matching policy`,
    matchedRule: asked ?? "",
  };
}
