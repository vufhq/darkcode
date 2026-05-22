import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ByokProvider } from "@darkcode/shared";

type ApiKeyStore = Partial<Record<ByokProvider, string>>;

const CONFIG_DIR = join(homedir(), ".darkcode");
const KEYS_FILE = join(CONFIG_DIR, "api-keys.json");

function readStore(): ApiKeyStore {
  try {
    const data = readFileSync(KEYS_FILE, "utf-8");
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === "object") {
      return parsed as ApiKeyStore;
    }
    return {};
  } catch {
    return {};
  }
}

function writeStore(store: ApiKeyStore) {
  if (!existsSync(CONFIG_DIR)) {
    // Owner-only permissions so other users can't read keys.
    mkdirSync(CONFIG_DIR, { mode: 0o700 });
  }
  writeFileSync(KEYS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

export function getApiKey(provider: ByokProvider): string | null {
  const store = readStore();
  const value = store[provider];
  return value && value.length > 0 ? value : null;
}

export function getAllApiKeys(): ApiKeyStore {
  return readStore();
}

export function setApiKey(provider: ByokProvider, key: string) {
  const store = readStore();
  store[provider] = key.trim();
  writeStore(store);
}

export function clearApiKey(provider: ByokProvider) {
  const store = readStore();
  delete store[provider];
  writeStore(store);
}

export function clearAllApiKeys() {
  try {
    unlinkSync(KEYS_FILE);
  } catch {
    // file doesn't exist
  }
}
