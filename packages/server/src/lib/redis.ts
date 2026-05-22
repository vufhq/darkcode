import { createClient, type RedisClientType } from "redis";
import { env } from "./env";
import { logger } from "./logger";

let client: RedisClientType | null = null;
let connectPromise: Promise<RedisClientType> | null = null;

export function isRedisConfigured() {
  return Boolean(env.REDIS_URL);
}

export async function getRedis(): Promise<RedisClientType | null> {
  if (!env.REDIS_URL) return null;
  if (client?.isOpen) return client;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const c = createClient({ url: env.REDIS_URL });
    c.on("error", (error) => logger.error({ err: error }, "redis.error"));
    await c.connect();
    logger.info("redis.connected");
    client = c as RedisClientType;
    return client;
  })();

  try {
    return await connectPromise;
  } finally {
    connectPromise = null;
  }
}

export async function closeRedis() {
  if (client?.isOpen) {
    await client.quit();
    client = null;
  }
}
