/* eslint-disable @typescript-eslint/no-explicit-any */
import { ObjectId } from "mongoose";

import { User } from "@User/Models";

const test = async () => {
  return "test";
};

const getMinimizedUserForJwtById = async (_id: ObjectId | string) => {
  return await User.findById(_id).select(
    `_id username avatar createdAt updatedAt`
  );
};

export { test, getMinimizedUserForJwtById };
