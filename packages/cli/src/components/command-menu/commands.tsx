import { SUPPORTED_CHAT_MODELS } from "@darkcode/shared";
import {
  AgentsDialogContent,
  AuditDialogContent,
  KeysDialogContent,
  McpDialogContent,
  ModelsDialogContent,
  PermissionsDialogContent,
  SessionsDialogContent,
  ThemeDialogContent,
} from "../dialogs";
import type { Command } from "./types";

import { performLogin } from "../../lib/oauth";
import { clearAuth } from "../../lib/auth";

import { openBillingPortal, openUpgradeCheckout } from "../../lib/upgrade";
import { apiClient } from "../../lib/api-client";
import { getErrorMessage } from "../../lib/http-errors";

export const COMMANDS: Command[] = [
  {
    name: "new",
    description: "Start a new conversation",
    value: "/new",
    action: (ctx) => {
      ctx.navigate("/");
    },
  },
  {
    name: "agents",
    description: "Switch agents",
    value: "/agents",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Select Agent",
        children: <AgentsDialogContent currentMode={ctx.mode} onSelectMode={ctx.setMode} />,
      })
    },
  },
  {
    name: "models",
    description: "Select AI model for generation",
    value: "/models",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Select Model",
        children: (
          <ModelsDialogContent
            models={SUPPORTED_CHAT_MODELS.map((model) => model.id)}
            currentModel={ctx.model}
            onSelectModel={ctx.setModel}
          />
        ),
      })
    },
  },
  {
    name: "keys",
    description: "Manage API keys for BYOK models",
    value: "/keys",
    action: (ctx) => {
      ctx.dialog.open({
        title: "API Keys",
        children: <KeysDialogContent />,
      });
    },
  },
  {
    name: "sessions",
    description: "Browse past sessions",
    value: "/sessions",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Sessions",
        children: <SessionsDialogContent />,
      })
    },
  },
  {
    name: "theme",
    description: "Change color theme",
    value: "/theme",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Select Theme",
        children: <ThemeDialogContent />,
      })
    },
  },
  {
    name: "login",
    description: "Sign in with your browser",
    value: "/login",
    action: async (ctx) => {
      ctx.toast.show({ message: "Opening browser to sign in..." });

      try {
        await performLogin();
        ctx.toast.show({ variant: "success", message: "Signed in" });
      } catch (error) {
        const message = error instanceof Error 
          ? error.message 
          : "Sign in failed or timed out";

        ctx.toast.show({ variant: "error", message });
      }
    },
  },
  {
    name: "logout",
    description: "Sign out of your account",
    value: "/logout",
    action: (ctx) => {
      clearAuth();
      ctx.toast.show({ variant: "success", message: "Signed out" });
    },
  },
  {
    name: "upgrade",
    description: "Buy more credits",
    value: "/upgrade",
    action: async (ctx) => {
      ctx.toast.show({ message: "Opening credits checkout..." });

      try {
        await openUpgradeCheckout();
        ctx.toast.show({
          variant: "success",
          message: "Checkout opened in browser",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to open checkout";
        ctx.toast.show({ variant: "error", message });
      }
    },
  },
  {
    name: "usage",
    description: "Open billing portal in your browser",
    value: "/usage",
    action: async (ctx) => {
      ctx.toast.show({ message: "Opening billing portal..." });

      try {
        await openBillingPortal();
        ctx.toast.show({
          variant: "success",
          message: "Billing portal opened in browser",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to open billing portal";
        ctx.toast.show({ variant: "error", message });
      }
    },
  },
  {
    name: "compact",
    description: "Summarize earlier turns to free up context window",
    value: "/compact",
    action: async (ctx) => {
      if (!ctx.sessionId) {
        ctx.toast.show({
          variant: "error",
          message: "Open a session before running /compact",
        });
        return;
      }
      ctx.toast.show({ message: "Compacting session..." });
      try {
        const res = await apiClient.sessions[":id"].compact.$post({
          param: { id: ctx.sessionId },
          json: {},
        });
        if (!res.ok) throw new Error(await getErrorMessage(res));
        const data = await res.json();
        if (!data.compacted) {
          ctx.toast.show({ message: "Nothing to compact yet" });
          return;
        }
        ctx.toast.show({
          variant: "success",
          message: `Summarized ${data.droppedCount} earlier ${
            data.droppedCount === 1 ? "message" : "messages"
          }`,
        });
      } catch (error) {
        ctx.toast.show({
          variant: "error",
          message: error instanceof Error ? error.message : "Compaction failed",
        });
      }
    },
  },
  {
    name: "mcp",
    description: "Browse configured MCP servers and their tools",
    value: "/mcp",
    action: (ctx) => {
      ctx.dialog.open({
        title: "MCP Servers",
        children: <McpDialogContent />,
      });
    },
  },
  {
    name: "permissions",
    description: "Show the effective permission policy",
    value: "/permissions",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Permissions",
        children: <PermissionsDialogContent />,
      });
    },
  },
  {
    name: "audit",
    description: "View recent permission decisions",
    value: "/audit",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Audit Log",
        children: <AuditDialogContent />,
      });
    },
  },
  {
    name: "yolo",
    description: "Auto-allow every tool call (use with care)",
    value: "/yolo",
    action: (ctx) => {
      ctx.setPosture("yolo");
      ctx.toast.show({
        variant: "error",
        message: "YOLO mode on — every tool call is auto-allowed",
      });
    },
  },
  {
    name: "auto-edit",
    description: "Auto-allow file writes; keep bash and MCP gated",
    value: "/auto-edit",
    action: (ctx) => {
      ctx.setPosture("auto-edit");
      ctx.toast.show({
        variant: "success",
        message: "Auto-edit mode on — file writes will skip the prompt",
      });
    },
  },
  {
    name: "safe",
    description: "Return to the default prompt-on-write posture",
    value: "/safe",
    action: (ctx) => {
      ctx.setPosture("normal");
      ctx.toast.show({
        variant: "success",
        message: "Safe mode — every side-effecting tool will prompt",
      });
    },
  },
  {
    name: "exit",
    description: "Quit the application",
    value: "/exit",
    action: (ctx) => {
      ctx.exit();
    },
  },
];
