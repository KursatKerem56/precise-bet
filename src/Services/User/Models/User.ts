/* eslint-disable @typescript-eslint/no-explicit-any */
import { Schema, model } from "mongoose";

import { IUser } from "@User/Types";

const UserSchema = new Schema<IUser>(
  {
    userId: { type: Number, required: true, unique: true },
    username: { type: String, unique: true },
    isEmailVerified: { type: Boolean, default: false },
    email: { type: String, required: false },
    password: { type: String },
    avatar: { type: String },
    accessToken: { token: String, expiresAt: Date },
  },
  { timestamps: true }
);

export default model<IUser>("User", UserSchema);
