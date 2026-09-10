import { Socket } from "socket.io";

import IUser from "@User/Types/User";

declare module "discord-webhook-node";

declare global {
  namespace Express {
    interface User extends IUser {}
  }
}

declare module "socket.io" {
  interface Socket {
    user?: IUser | null;
    ip?: string;
  }
}

declare module "socket.io" {
  interface RemoteSocket {
    user?: IUser | null;
  }
}

declare module "express-serve-static-core" {
  export interface Request {
    socketio: Socket;
  }
}

declare module "express-session" {
  interface Session {
    user?: IUser;
    socketId?: string;
    socket?: Socket;
    adminUser?: IAdminContext;
    is2FAVerified?: boolean;
  }
}
