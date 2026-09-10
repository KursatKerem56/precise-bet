import { Request, Response } from "express";

const setRealUserIP = (req: Request, res: Response, next: () => void) => {
  const temp = req.ip;
  Object.defineProperty(req, "ip", {
    get: function () {
      return req.headers["x-real-ip"] || temp;
    },
    configurable: true,
  });
  next();
};

export default setRealUserIP;
