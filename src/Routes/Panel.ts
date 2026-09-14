import { Router } from "express";

import { isAuth } from "@Middlewares/Auth";

import { saveSiteLink } from "@Controllers/Panel";

const router = Router();

router.post("/save-site-link", isAuth, saveSiteLink);

export default router;
