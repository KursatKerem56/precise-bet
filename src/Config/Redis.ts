import { createClient } from "redis";
import RedisStore from "connect-redis";

import logger from "@Utils/Logger";
import config from "@Config/Environment";

// Initialize client.
const redis = createClient({
  url: config.db.redis.uri,
  socket: {
    connectTimeout: 10000,
  },
});

redis
  .connect()
  .then(() => {
    logger.info("Redis connected...");
  })
  .catch((err) => {
    logger.error("Error connecting to redis", err);
  });

// Initialize store.
const redisStore = new RedisStore({
  client: redis,
  prefix: config.session.prefix + ":",
});

export { redis, redisStore };
