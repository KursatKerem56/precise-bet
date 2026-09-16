import { Request, Response } from "express";

import {
  getSiteLinks as _getSiteLinks,
  saveSiteLink as _saveSiteLink,
  getMatches as _getMatches,
  getComparedMatches as _getComparedMatches,
} from "@Panel";

import { AppError, asyncErrorHandler } from "@Utils/Error";

const getSiteLinks = asyncErrorHandler(async (req: Request, res: Response) => {
  res.json(await _getSiteLinks());
});

const saveSiteLink = asyncErrorHandler(async (req: Request, res: Response) => {
  const { site, link } = req.body;

  if (!site || !link) throw new AppError("MISSING_PARAMETERS");

  res.json(await _saveSiteLink(site, link));
});

const getMatches = asyncErrorHandler(async (req: Request, res: Response) => {
  res.json(await _getMatches());
});
const getComparedMatches = asyncErrorHandler(
  async (req: Request, res: Response) => {
    res.json(await _getComparedMatches());
  }
);

export { getSiteLinks, saveSiteLink, getMatches, getComparedMatches };
