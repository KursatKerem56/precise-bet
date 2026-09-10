import { Router } from "express";

import { isAuth } from "@Middlewares/Auth";

import { test, getMe } from "@Controllers/User";

const router = Router();

router.get("/test", test);

/*
 * @route GET /user/me
 * @desc Get current user
 * @access Private
 * @returns Current user
 */
router.get("/me", isAuth, getMe);

export default router;
