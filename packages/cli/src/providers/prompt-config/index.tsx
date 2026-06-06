import { createContext, useContext, useState, useCallback, useEffect } from "react";
import type { ReactNode } from "react";
import {
  DEFAULT_CHAT_MODEL_ID,
  Mode,
  type ModeType,
  type SupportedChatModelId,
} from "@darkcode/shared";
import {
  setPermissionPosture,
  type PermissionPosture,
} from "../../lib/permissions/engine";
import type { CreditsState } from "../../lib/credits";

export type ContextUsage = {
  estimatedTokens: number;
  contextWindow: number;
};

type PromptConfigContextValue = {
  mode: ModeType;
  toggleMode: () => void;
  setMode: (mode: ModeType) => void;
  model: SupportedChatModelId;
  setModel: (model: SupportedChatModelId) => void;
  contextUsage: ContextUsage | null;
  setContextUsage: (usage: ContextUsage | null) => void;
  // Last-known DarkCode credit balance for the status-bar gauge. `null` until
  // first fetched; an explicit "unavailable" CreditsState when the balance
  // couldn't be loaded (never silently 0).
  credits: CreditsState | null;
  setCredits: (credits: CreditsState | null) => void;
  posture: PermissionPosture;
  setPosture: (posture: PermissionPosture) => void;
};

const PromptConfigContext = createContext<PromptConfigContextValue | null>(null);

export function usePromptConfig(): PromptConfigContextValue {
  const value = useContext(PromptConfigContext);
  if (!value) {
    throw new Error("usePromptConfig must be used within a PromptConfigProvider");
  }
  return value;
};

type PromptConfigProviderProps = {
  children: ReactNode;
};

export function PromptConfigProvider({ children }: PromptConfigProviderProps) {
  const [mode, setMode] = useState<ModeType>(Mode.BUILD);
  const [model, setModel] = useState<SupportedChatModelId>(DEFAULT_CHAT_MODEL_ID);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [credits, setCredits] = useState<CreditsState | null>(null);
  const [posture, setPostureState] = useState<PermissionPosture>("normal");

  const toggleMode = useCallback(() => {
    setMode((m) => (m === Mode.BUILD ? Mode.PLAN : Mode.BUILD));
  }, []);

  const setPosture = useCallback((next: PermissionPosture) => {
    setPostureState(next);
    setPermissionPosture(next);
  }, []);

  // Keep the engine's module-level posture in sync on mount so a refresh
  // doesn't strand the engine on "normal" while UI state shows something else.
  useEffect(() => {
    setPermissionPosture(posture);
  }, [posture]);

  return (
    <PromptConfigContext.Provider
      value={{
        mode,
        toggleMode,
        setMode,
        model,
        setModel,
        contextUsage,
        setContextUsage,
        credits,
        setCredits,
        posture,
        setPosture,
    }}>
      {children}
    </PromptConfigContext.Provider>
  );
};
