import { Router } from "express";

import { isAuth } from "@Middlewares/Auth";

import {
  getSiteLinks,
  saveSiteLink,
  getMatches,
  getComparedMatches,
  saveMatchTimesDiff,
} from "@Controllers/Panel";

const router = Router();

router.get("/site-links", isAuth, getSiteLinks);

router.post("/save-site-link", isAuth, saveSiteLink);

router.get("/matches", isAuth, getMatches);

router.get("/compared-matches", isAuth, getComparedMatches);

router.post("/match-times-diff", isAuth, saveMatchTimesDiff);

export default router;
