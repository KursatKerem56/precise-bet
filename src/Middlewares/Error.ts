import { Request, Response, NextFunction } from "express";

import { Errors } from "@Common/Constants";

import { AppError } from "@Utils/Error";

const errorMiddleware = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      statusCode: err.statusCode,
      locale_key: err.locale_key,
      message: err.message,
    });
  }

  console.log(err);

  const error = Errors.UNEXPECTED_ERROR;

  return res.status(error.statusCode).json({
    statusCode: error.statusCode,
    locale_key: error.locale_key,
    message: error.message,
  });
};

export { errorMiddleware };
