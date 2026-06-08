import { useCallback } from "react";
import { TextAttributes } from "@opentui/core";
import { useDialog } from "../../providers/dialog";
import { useToast } from "../../providers/toast";
import { DialogSearchList } from "../dialog-search-list";
import {
  findSupportedChatModel,
  getModelDisplayName,
  type SupportedChatModelId,
} from "@darkcode/shared";
import { getApiKey } from "../../lib/api-keys";
import { ApiKeyDialogContent } from "./api-key-dialog";

type ModelsDialogContentProps = {
  models: SupportedChatModelId[];
  currentModel: SupportedChatModelId;
  onSelectModel: (modelId: SupportedChatModelId) => void;
};

export const ModelsDialogContent = ({
  models,
  currentModel,
  onSelectModel,
}: ModelsDialogContentProps) => {
  const dialog = useDialog();
  const toast = useToast();

  const handleSelect = useCallback(
    (modelId: SupportedChatModelId) => {
      const definition = findSupportedChatModel(modelId);
      if (!definition) return;
      const displayName = definition.displayName;

      // Only force a key when the model can't run on DarkCode credits. Hostable
      // models (canBeHosted) run on credits without a key — the user can still
      // add one later via /keys to switch that model to BYOK. A model that both
      // requires a key and can't be hosted is unusable without one, so prompt.
      // (No such model exists today, so TS narrows that branch to `never`;
      // capture `provider` while `definition` is still the BYOK variant.)
      if (definition.requiresApiKey) {
        const provider = definition.byokProvider;
        if (!definition.canBeHosted && !getApiKey(provider)) {
          dialog.open({
            title: `Add ${provider} API key`,
            children: (
              <ApiKeyDialogContent
                provider={provider}
                onSaved={() => {
                  onSelectModel(modelId);
                  toast.show({
                    variant: "success",
                    message: `Switched to ${displayName}`,
                  });
                }}
              />
            ),
          });
          return;
        }
      }

      onSelectModel(modelId);
      dialog.close();
      toast.show({
        variant: "success",
        message: `Switched to ${displayName}`,
      });
    },
    [dialog, onSelectModel, toast],
  );

  return (
    <DialogSearchList
      items={models}
      onSelect={handleSelect}
      filterFn={(modelId, query) =>
        getModelDisplayName(modelId).toLowerCase().includes(query.toLowerCase())
      }
      renderItem={(modelId, isSelected) => {
        const definition = findSupportedChatModel(modelId);
        const isCurrent = modelId === currentModel;
        const requiresKey = definition?.requiresApiKey ?? false;
        const canBeHosted = definition?.canBeHosted ?? false;
        const hasKey =
          definition && definition.requiresApiKey
            ? getApiKey(definition.byokProvider) != null
            : false;

        // Premium-tier model: gated behind Pro when run on our infra (unless the
        // user brought their own key, in which case "BYOK" wins below).
        const isPro =
          definition != null && "tier" in definition && definition.tier === "pro";

        // "Hosted" = keyless on our infra (the default model); "Local" = Ollama;
        // "BYOK" = the user's own key; "Pro" = a premium hosted model (needs a
        // Pro subscription); "Credits" = a hostable model with no key yet (runs
        // on our infra, billed to credits); "Needs key" = BYOK-only.
        const tag = !requiresKey
          ? canBeHosted
            ? "Hosted"
            : "Local"
          : hasKey
            ? "BYOK"
            : isPro
              ? "Pro"
              : canBeHosted
                ? "Credits"
                : "Needs key";

        return (
          <box flexDirection="row" gap={1} width="100%" paddingX={1}>
            <text selectable={false} fg={isSelected ? "black" : "white"}>
              {isCurrent ? "•" : " "}
            </text>
            <box flexGrow={1} flexShrink={1} overflow="hidden">
              <text selectable={false} fg={isSelected ? "black" : "white"}>
                {getModelDisplayName(modelId)}
              </text>
            </box>
            <box width={10} alignItems="flex-end" flexShrink={0}>
              <text
                selectable={false}
                attributes={TextAttributes.DIM}
                fg={isSelected ? "black" : "gray"}
              >
                {tag}
              </text>
            </box>
          </box>
        );
      }}
      getKey={(modelId) => modelId}
      placeholder="Search models"
      emptyText="No matching models"
    />
  );
};
