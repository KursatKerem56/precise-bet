/* eslint-disable @typescript-eslint/no-explicit-any */
import { Schema, model } from "mongoose";

import { IPanelSite } from "@Panel/Types";

import { EPanelSite } from "@Panel/Constants";

const PanelSiteSchema = new Schema<IPanelSite>(
  {
    site: { type: String, enum: EPanelSite, required: true },
    link: { type: String, required: true },
  },
  { timestamps: true }
);

export default model<IPanelSite>("Site", PanelSiteSchema);
