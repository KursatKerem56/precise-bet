import { redis } from "@Config/Redis";

import logger from "@Utils/Logger";

const updateFetcherStatus = async (status: string) => {
  logger.info("Updating fetcher status to:", status);

  await redis.set("fetcher:status", status);
};

const getFetcherStatus = async () => {
  return await redis.get("fetcher:status");
};

export { updateFetcherStatus, getFetcherStatus };
