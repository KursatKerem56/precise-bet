import { Router } from "express";

import { isAuth } from "@Middlewares/Auth";

import {
  getSiteLinks,
  saveSiteLink,
  getMatches,
  getComparedMatches,
  updateFetcherStatus,
  saveMatchTimesDiff,
} from "@Controllers/Panel";

const router = Router();

router.get("/site-links", isAuth, getSiteLinks);

router.post("/save-site-link", isAuth, saveSiteLink);

router.get("/matches", isAuth, getMatches);

router.get("/compared-matches", isAuth, getComparedMatches);

router.post("/fetcher-status", isAuth, updateFetcherStatus);

router.post("/match-times-diff", isAuth, saveMatchTimesDiff);

export default router;
