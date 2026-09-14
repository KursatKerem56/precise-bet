import { NextFunction, Request, Response } from "express";

import config from "@Config/Environment";

const isAuth = async (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization;

  if (token !== config.auth.token) {
    res.status(401).send({
      statusCode: 401,
      message: "auth.error.notAuthenticated",
      error: "auth.error.notAuthenticated",
    });
    return;
  }

  next();
};

export { isAuth };
