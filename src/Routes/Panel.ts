import { Router } from "express";

import { isAuth } from "@Middlewares/Auth";

import { saveSiteLink, getMatches, compareMatches } from "@Controllers/Panel";

const router = Router();

router.post("/save-site-link", isAuth, saveSiteLink);

router.get("/matches", isAuth, getMatches);

router.get("/compare-matches", isAuth, compareMatches);

export default router;
