import { afterEach, describe, expect, mock, test } from "bun:test";

// polar-outbox.ts pulls in env-validated singletons transitively (./polar ->
// ./env throws without a full env). We mock its four direct dependencies so
// the unit runs in isolation — no env, no Polar SDK, no database. The dynamic
// import below MUST come after the mocks are registered.

type OutboxCreateArg = {
  data: {
    eventId: string;
    userId: string;
    credits: number;
    attempts: number;
    lastAttempt: Date;
    lastError: string;
  };
};

const ingestAiUsage = mock(async (_args: unknown): Promise<void> => {});
const create = mock(async (_args: OutboxCreateArg): Promise<unknown> => ({}));
const captureException = mock((_err: unknown, _ctx?: unknown): void => {});

mock.module("./polar", () => ({ ingestAiUsage }));
mock.module("@darkcode/database/client", () => ({
  db: { polarIngestOutbox: { create } },
}));
mock.module("./logger", () => ({
  logger: {
    warn() {},
    debug() {},
    info() {},
    error() {},
    fatal() {},
    trace() {},
  },
}));
mock.module("./sentry", () => ({ captureException }));

const { ingestAiUsageWithOutbox } = await import("./polar-outbox");

const ARGS = { externalCustomerId: "user-1", eventId: "evt-1", credits: 5 };

afterEach(() => {
  ingestAiUsage.mockReset();
  create.mockReset();
  captureException.mockReset();
});

describe("ingestAiUsageWithOutbox", () => {
  test("skips ingest entirely for non-positive credits", async () => {
    const ok = await ingestAiUsageWithOutbox({ ...ARGS, credits: 0 });
    expect(ok).toBe(true);
    expect(ingestAiUsage).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  test("ingests inline and does NOT touch the outbox on success", async () => {
    const ok = await ingestAiUsageWithOutbox(ARGS);
    expect(ok).toBe(true);
    expect(ingestAiUsage).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  test("queues the event to the outbox when inline ingest fails", async () => {
    ingestAiUsage.mockImplementation(async () => {
      throw new Error("polar 503");
    });

    const ok = await ingestAiUsageWithOutbox(ARGS);

    expect(ok).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    const row = create.mock.calls[0]![0].data;
    expect(row.eventId).toBe("evt-1");
    expect(row.userId).toBe("user-1");
    expect(row.credits).toBe(5);
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("polar 503");
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  test("swallows a duplicate-row insert error and still reports failure", async () => {
    ingestAiUsage.mockImplementation(async () => {
      throw new Error("polar 503");
    });
    create.mockImplementation(async () => {
      throw new Error("unique constraint violation on eventId");
    });

    const ok = await ingestAiUsageWithOutbox(ARGS);

    // The duplicate insert is expected (the row was already queued) — it must
    // not throw out of the function. The result still signals inline failure.
    expect(ok).toBe(false);
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
