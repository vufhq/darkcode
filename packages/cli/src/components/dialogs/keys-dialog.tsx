import { useCallback, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useDialog } from "../../providers/dialog";
import { useToast } from "../../providers/toast";
import { DialogSearchList } from "../dialog-search-list";
import { ApiKeyDialogContent } from "./api-key-dialog";
import { clearApiKey, getApiKey } from "../../lib/api-keys";
import {
  BYOK_PROVIDERS,
  BYOK_PROVIDER_LABELS,
  type ByokProvider,
} from "@darkcode/shared";

type ProviderRow = {
  provider: ByokProvider;
  label: string;
};

const PROVIDERS: ProviderRow[] = BYOK_PROVIDERS.map((provider) => ({
  provider,
  label: BYOK_PROVIDER_LABELS[provider],
}));

export function KeysDialogContent() {
  const dialog = useDialog();
  const toast = useToast();
  // Force a re-render after we save or clear a key.
  const [revision, setRevision] = useState(0);

  const handleSelect = useCallback(
    (row: ProviderRow) => {
      const existing = getApiKey(row.provider);

      if (existing) {
        clearApiKey(row.provider);
        toast.show({
          variant: "success",
          message: `Cleared ${row.label} API key`,
        });
        setRevision((r) => r + 1);
        return;
      }

      dialog.open({
        title: `Add ${row.label} API key`,
        children: (
          <ApiKeyDialogContent
            provider={row.provider}
            onSaved={() => setRevision((r) => r + 1)}
          />
        ),
      });
    },
    [dialog, toast],
  );

  return (
    <DialogSearchList
      key={revision}
      items={PROVIDERS}
      onSelect={handleSelect}
      filterFn={(row, query) => row.label.toLowerCase().includes(query.toLowerCase())}
      renderItem={(row, isSelected) => {
        const hasKey = getApiKey(row.provider) != null;
        return (
          <box flexDirection="row" width="100%" paddingX={1} gap={1}>
            <box flexGrow={1}>
              <text selectable={false} fg={isSelected ? "black" : "white"}>
                {row.label}
              </text>
            </box>
            <text
              selectable={false}
              attributes={TextAttributes.DIM}
              fg={isSelected ? "black" : "gray"}
            >
              {hasKey ? "set · enter to clear" : "not set · enter to add"}
            </text>
          </box>
        );
      }}
      getKey={(row) => row.provider}
      placeholder="Search providers"
      emptyText="No providers"
    />
  );
}
