import { Application } from "express";

import User from "@Routes/User";
import Panel from "@Routes/Panel";

const setupRoutes = (app: Application) => {
  app.use("/user", User);
  app.use("/panel", Panel);

  app.use("/health-check", (req, res) =>
    res
      .status(200)
      .send(`<div>SERVER IS RUNNING</div><div style="display: none;">:)</div>`)
  );
};

export default setupRoutes;
