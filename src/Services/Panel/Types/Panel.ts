import { Document } from "mongoose";

import { EPanelSite } from "@Panel/Constants";

interface IPanelSite extends Document {
  site: EPanelSite;
  link: string;
  createdAt: Date;
  updatedAt: Date;
}

export { IPanelSite };
