import mongoose from "mongoose";

import logger from "@Utils/Logger";

const connectDB = async () => {
  try {
    if (!process.env.MONGO_URI) {
      logger.fatal("MongoDB URI not found");
      process.exit(1);
    }

    const dbConnection = await mongoose.connect(process.env.MONGO_URI);

    logger.info("MongoDB connected...");

    return dbConnection;
  } catch (error) {
    logger.fatal("Error connecting to MongoDB", error);
    process.exit(1);
  }
};

export default connectDB;
