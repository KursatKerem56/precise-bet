import {
  getMatches as _getMatches,
  compareMatches as _compareMatches,
} from "@Match";

import { PanelSite } from "@Panel/Models";

import { EPanelSite } from "@Panel/Constants";

import { AppError } from "@Utils/Error";

const saveSiteLink = async (site: EPanelSite, link: string) => {
  if (!Object.values(EPanelSite).includes(site)) {
    throw new AppError("INVALID_SITE");
  }

  let panelSite = await PanelSite.findOneAndUpdate(
    { site },
    { link },
    { new: true }
  );

  if (!panelSite) {
    panelSite = await PanelSite.create({ site, link });
  }

  return panelSite;
};

const getSites = async () => {
  return await PanelSite.find();
};

const getMatches = async () => {
  return await _getMatches();
};

const compareMatches = async () => {
  return await _compareMatches();
};

export { saveSiteLink, getSites, getMatches, compareMatches };
