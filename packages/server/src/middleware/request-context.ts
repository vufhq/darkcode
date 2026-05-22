import { createMiddleware } from "hono/factory";
import { randomUUID } from "crypto";
import { logger, type Logger } from "../lib/logger";

export type RequestContextEnv = {
  Variables: {
    requestId: string;
    log: Logger;
  };
};

const REQUEST_ID_HEADER = "x-request-id";

export const requestContext = createMiddleware<RequestContextEnv>(async (c, next) => {
  const incoming = c.req.header(REQUEST_ID_HEADER);
  const requestId = incoming && incoming.length <= 128 ? incoming : randomUUID();

  const reqLog = logger.child({ requestId });
  c.set("requestId", requestId);
  c.set("log", reqLog);
  c.header(REQUEST_ID_HEADER, requestId);

  const start = Date.now();
  reqLog.debug({ method: c.req.method, path: c.req.path }, "request.start");

  try {
    await next();
  } finally {
    reqLog.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - start,
      },
      "request.finish",
    );
  }
});
