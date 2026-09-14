import { Request, Response } from "express";

import { saveSiteLink as _saveSiteLink } from "@Panel";

import { AppError, asyncErrorHandler } from "@Utils/Error";

const saveSiteLink = asyncErrorHandler(async (req: Request, res: Response) => {
  const { site, link } = req.body;

  if (!site || !link) throw new AppError("MISSING_PARAMETERS");

  res.json(await _saveSiteLink(site, link));
});
export { saveSiteLink };
