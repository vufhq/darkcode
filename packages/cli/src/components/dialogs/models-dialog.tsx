import { useCallback } from "react";
import { TextAttributes } from "@opentui/core";
import { useDialog } from "../../providers/dialog";
import { useToast } from "../../providers/toast";
import { DialogSearchList } from "../dialog-search-list";
import {
  findSupportedChatModel,
  getModelDisplayName,
  type ByokProvider,
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

      if (definition.requiresApiKey) {
        const provider = definition.provider as ByokProvider;
        if (!getApiKey(provider)) {
          dialog.open({
            title: `Add ${provider} API key`,
            children: (
              <ApiKeyDialogContent
                provider={provider}
                onSaved={() => {
                  onSelectModel(modelId);
                  toast.show({
                    variant: "success",
                    message: `Switched to ${definition.displayName}`,
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
        message: `Switched to ${definition.displayName}`,
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
        const hasKey = requiresKey
          ? getApiKey((definition!.provider as ByokProvider)) != null
          : true;

        const tag = !requiresKey
          ? "Hosted"
          : hasKey
            ? "BYOK"
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
