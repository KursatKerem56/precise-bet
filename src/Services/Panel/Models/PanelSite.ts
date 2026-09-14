/* eslint-disable @typescript-eslint/no-explicit-any */
import { Schema, model } from "mongoose";

import { IPanelSite } from "@Panel/Types";

const PanelSiteSchema = new Schema<IPanelSite>(
  {
    site: { type: String, required: true },
    link: { type: String, required: true },
  },
  { timestamps: true }
);

export default model<IPanelSite>("Site", PanelSiteSchema);
