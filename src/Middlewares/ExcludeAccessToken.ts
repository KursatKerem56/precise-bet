import { NextFunction, Response, Request } from "express";

export const excludeAccessToken = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const send = res.send;
  res.send = function (body): Response<unknown, Record<string, unknown>> {
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(body);
    } catch (err) {
      return send.call(this, body);
    }

    if (!parsedBody) {
      return send.call(this, body);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const removeAccessToken = (obj: any) => {
      if (typeof obj !== "object" || obj === null) {
        return;
      }

      if (Array.isArray(obj)) {
        for (const item of obj) {
          removeAccessToken(item);
        }
      } else {
        for (const key in obj) {
          if (key === "accessToken" || key === "lastLogin") {
            delete obj[key];
          } else if (typeof obj[key] === "object" && obj[key] !== null) {
            removeAccessToken(obj[key]);
          }
        }
      }
    };

    if (!req.url.endsWith("/me")) {
      try {
        removeAccessToken(parsedBody);
      } catch (err) {
        console.log(err);
      }
    }

    return send.call(this, JSON.stringify(parsedBody));
  };

  next();
};
