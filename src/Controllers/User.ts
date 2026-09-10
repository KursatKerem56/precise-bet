import { Request, Response } from "express";

import config from "@Config/Environment";

import { test as _test } from "@User";

import { AppError, asyncErrorHandler } from "@Utils/Error";

const test = asyncErrorHandler(async (req: Request, res: Response) => {
  res.json(await _test());
});

const getMe = asyncErrorHandler((req: Request, res: Response) => {
  res.json(req.user);
});

export { test, getMe };
