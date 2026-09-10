import { Request, Response, NextFunction } from "express";
import { validationResult } from "express-validator";

import reCaptchaV2 from "@Config/Google/ReCaptchaV2";

const checkValidation = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      statusCode: 422,
      message: errors.array().map((error) => error.msg),
      error: "validation.error",
    });
  }
  next();
};

const checkRecaptcha = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const humanKey = req.body.humanKey;

  if (!humanKey) {
    return res.status(400).json({
      statusCode: 400,
      message:
        "Please complete the reCaptcha challenge. If you are not a bot, please contact support.",
      error: "validation.error",
    });
  }

  const header = req.headers["x-forwarded-for"];
  const ip = header
    ? typeof header === "string"
      ? `${header.split(",")[0]}`
      : `${header[0]}`
    : null;

  const isValid = await reCaptchaV2.verify(humanKey, ip ?? undefined);

  if (!isValid) {
    return res.status(400).json({
      statusCode: 400,
      message:
        "Please complete the reCaptcha challenge. If you are not a bot, please contact support.",
      error: "validation.error",
    });
  }

  next();
};

export { checkValidation, checkRecaptcha };
