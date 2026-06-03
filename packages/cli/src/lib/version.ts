/**
 * CLI version string.
 *
 * Injected at build time by the release workflow via
 * `bun build --define 'process.env.DARKCODE_VERSION="<tag>"'`, which replaces
 * this read with a string literal in the compiled binary. Falls back to "dev"
 * for source/dev runs where it isn't defined.
 */
export const VERSION = process.env.DARKCODE_VERSION ?? "dev";
