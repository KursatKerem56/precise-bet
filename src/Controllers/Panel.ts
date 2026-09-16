import { Request, Response } from "express";

import {
  saveSiteLink as _saveSiteLink,
  getMatches as _getMatches,
  compareMatches as _compareMatches,
} from "@Panel";

import { AppError, asyncErrorHandler } from "@Utils/Error";

const saveSiteLink = asyncErrorHandler(async (req: Request, res: Response) => {
  const { site, link } = req.body;

  if (!site || !link) throw new AppError("MISSING_PARAMETERS");

  res.json(await _saveSiteLink(site, link));
});

const getMatches = asyncErrorHandler(async (req: Request, res: Response) => {
  res.json(await _getMatches());
});
const compareMatches = asyncErrorHandler(
  async (req: Request, res: Response) => {
    res.json(await _compareMatches());
  }
);

export { saveSiteLink, getMatches, compareMatches };
