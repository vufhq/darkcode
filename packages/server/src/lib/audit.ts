import { db } from "@darkcode/database/client";
import { logger } from "./logger";

export type AuditAction =
  | "auth.login"
  | "auth.logout"
  | "auth.token_refresh"
  | "session.create"
  | "session.compact"
  | "billing.checkout"
  | "billing.checkout_pro"
  | "billing.portal"
  | "billing.free_tier_granted"
  | "credits.depleted"
  | "pro.required";

type AuditEvent = {
  userId: string;
  action: AuditAction;
  requestId?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Persists an audit event. Never throws — audit failures must not block the
 * action they describe (a logout that worked but couldn't be logged is still
 * a logout). All errors get pino-logged so the gap is visible.
 */
export async function logAuditEvent(event: AuditEvent): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        userId: event.userId,
        action: event.action,
        requestId: event.requestId,
        metadata: event.metadata ? (event.metadata as object) : undefined,
      },
    });
  } catch (error) {
    logger.warn({ err: error, action: event.action, userId: event.userId }, "audit.write_failed");
  }
}
