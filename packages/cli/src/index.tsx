#!/usr/bin/env bun
import { VERSION } from "./lib/version";

const HELP = `darkcode — a terminal-based AI coding agent

Usage:
  darkcode              Start the interactive agent in the current directory
  darkcode --help       Show this help and exit
  darkcode --version    Print the version and exit

Environment overrides (optional):
  DARKCODE_API_URL      API origin to connect to (default: https://api.darkcode.sh)

Once running, use slash commands: /login, /models, /keys, /new, /sessions, /agents.
Docs: https://darkcode.sh/docs
`;

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(HELP);
  process.exit(0);
}

// Defer the heavy OpenTUI import (which loads the native render library) until
// after the fast-path flags above, so `--help`/`--version` never touch it.
const { boot } = await import("./boot");
await boot();
