import * as Sentry from "@sentry/node";
import jwt from "jsonwebtoken";
import { NextFunction, Request, Response } from "express";

import config from "@Config/Environment";

import { getMinimizedUserForJwtById } from "@User";

import logger from "@Utils/Logger";
import { AppError, asyncErrorHandler } from "@Utils/Error";

const serializeUserWithJWT = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const token = req.headers.authorization?.split(" ")[1];

  if (token) {
    try {
      const { userId } = jwt.verify(token, config.auth.jwt.secret) as {
        userId: string;
      };

      const user = await getMinimizedUserForJwtById(userId);

      if (user) {
        Sentry.setUser({
          id: user._id,
          username: user.name,
          avatar: user.avatar,
          created_at: user.createdAt,
          updated_at: user.updatedAt,
        });

        req.user = user;
      }
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        res.status(401).send({
          statusCode: 401,
          message: "auth.error.tokenExpired",
          error: "AUTH_TOKEN_EXPIRED",
        });
        return;
        // return new AppError(
        //   "AUTH_TOKEN_EXPIRED",
        //   "While serializing user with JWT"
        // );
      }
    }
  }

  next();
};

const isAuth = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    res.status(401).send({
      statusCode: 401,
      message: "auth.error.notAuthenticated",
      error: "auth.error.notAuthenticated",
    });
    return;
  }

  next();
};

export { serializeUserWithJWT, isAuth };
