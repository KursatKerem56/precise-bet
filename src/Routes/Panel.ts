import { Router } from "express";

import { isAuth } from "@Middlewares/Auth";

import {
  getSiteLinks,
  saveSiteLink,
  getMatches,
  getComparedMatches,
} from "@Controllers/Panel";

const router = Router();

router.get("/site-links", isAuth, getSiteLinks);

router.post("/save-site-link", isAuth, saveSiteLink);

router.get("/matches", isAuth, getMatches);

router.get("/compared-matches", isAuth, getComparedMatches);

export default router;
