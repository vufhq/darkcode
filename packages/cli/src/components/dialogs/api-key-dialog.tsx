import { useCallback, useRef, useState } from "react";
import { TextAttributes, type InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useDialog } from "../../providers/dialog";
import { useToast } from "../../providers/toast";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { setApiKey } from "../../lib/api-keys";
import type { ByokProvider } from "@darkcode/shared";

type ApiKeyDialogContentProps = {
  provider: ByokProvider;
  onSaved?: () => void;
};

const PROVIDER_LABELS: Record<ByokProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

export function ApiKeyDialogContent({ provider, onSaved }: ApiKeyDialogContentProps) {
  const inputRef = useRef<InputRenderable>(null);
  const [value, setValue] = useState("");
  const dialog = useDialog();
  const toast = useToast();
  const { isTopLayer } = useKeyboardLayer();

  const save = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      toast.show({ variant: "error", message: "API key is empty" });
      return;
    }

    setApiKey(provider, trimmed);
    toast.show({
      variant: "success",
      message: `Saved ${PROVIDER_LABELS[provider]} API key`,
    });
    dialog.close();
    onSaved?.();
  }, [dialog, onSaved, provider, toast, value]);

  useKeyboard((key) => {
    if (!isTopLayer("dialog")) return;

    if (key.name === "return" || key.name === "enter") {
      save();
    }
  });

  return (
    <box flexDirection="column" gap={1}>
      <text attributes={TextAttributes.DIM}>
        Paste your {PROVIDER_LABELS[provider]} API key. Stored locally at
        ~/.darkcode/api-keys.json
      </text>
      <input
        ref={inputRef}
        focused
        placeholder={provider === "anthropic" ? "sk-ant-..." : "sk-..."}
        onContentChange={() => setValue(inputRef.current?.value ?? "")}
      />
      <text attributes={TextAttributes.DIM}>enter to save · esc to cancel</text>
    </box>
  );
}
