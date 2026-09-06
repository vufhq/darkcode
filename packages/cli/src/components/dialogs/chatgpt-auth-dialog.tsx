import { useEffect, useRef, useState } from "react";
import { DialogSearchList } from "../dialog-search-list";
import { openAIOAuth } from "../../lib/openai-oauth";
import { API_URL } from "../../lib/config";
import { assertOAuthServerUrl } from "@darkcode/shared";

export function ChatGPTAuthDialogContent() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(openAIOAuth.connected() ? "Connected" : "Not connected");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const items = busy ? ["Cancel login"] : [openAIOAuth.connected() ? "Reconnect in browser" : "Connect in browser", "Disconnect"];
  return <box flexDirection="column" gap={1}>
    <text fg="white">ChatGPT: {status}</text>
    <text fg="white">Your ChatGPT access token is forwarded to the configured DarkCode server for inference. Connect only if you trust this server:</text>
    <text fg="white">{API_URL}</text>
    <text fg="white">Refresh tokens stay on this machine. This is separate from OpenAI API keys and DarkCode login.</text>
    <DialogSearchList items={items} getKey={(item) => item} placeholder="Choose authentication action"
      filterFn={(item, query) => item.toLowerCase().includes(query.toLowerCase())}
      renderItem={(item, selected) => <text fg={selected ? "black" : "white"}>{item}</text>}
      onSelect={async (item) => {
        if (item === "Cancel login") { pending.current?.abort(); return; }
        if (item === "Disconnect") {
          setStatus("Disconnecting; waiting for any in-progress credential update...");
          try { await openAIOAuth.disconnect(); setStatus("Disconnected (local credentials removed)"); }
          catch { setStatus("Could not remove local credentials. Access is blocked for this process."); }
          return;
        }
        if (pending.current) return;
        try { assertOAuthServerUrl(API_URL); } catch (error) { setStatus((error as Error).message); return; }
        const controller = new AbortController();
        pending.current = controller;
        setBusy(true);
        setStatus("Waiting for browser approval (5-minute timeout; Escape cancels)");
        void openAIOAuth.connect(controller.signal).then(() => {
          if (!controller.signal.aborted) setStatus("Connected. Select GPT-5.4 (ChatGPT) in /models.");
        }).catch((error: unknown) => {
          setStatus(error instanceof Error ? error.message : "ChatGPT connection failed.");
        }).finally(() => { pending.current = null; setBusy(false); });
      }} />
  </box>;
}
