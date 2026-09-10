import { Document } from "mongoose";

interface IUser extends Document {
  userId: number;
  username: string;
  isEmailVerified: boolean;
  email: string;
  password?: string;
  avatar?: string;
  accessToken: {
    token: string;
    expiresAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

export default IUser;

export {};
