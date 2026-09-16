import { Router } from "express";

import { isAuth } from "@Middlewares/Auth";

import { saveSiteLink, getMatches } from "@Controllers/Panel";

const router = Router();

router.post("/save-site-link", isAuth, saveSiteLink);

router.get("/matches", isAuth, getMatches);

export default router;
