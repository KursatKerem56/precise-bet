import { Application } from "express";

import User from "@Routes/User";

const setupRoutes = (app: Application) => {
  // User
  app.use("/user", User);

  app.use("/health-check", (req, res) =>
    res
      .status(200)
      .send(`<div>SERVER IS RUNNING</div><div style="display: none;">:)</div>`)
  );
};

export default setupRoutes;
