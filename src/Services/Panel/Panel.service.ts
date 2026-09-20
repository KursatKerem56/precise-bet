import {
  getMatches as _getMatches,
  getComparedMatches as _getComparedMatches,
} from "@Match";

import { PanelSite } from "@Panel/Models";

import { EPanelSite } from "@Panel/Constants";

import { AppError } from "@Utils/Error";

const getSiteLinks = async () => {
  return await PanelSite.find({}, { _id: 0, site: 1, link: 1 });
};

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

const getComparedMatches = async () => {
  return await _getComparedMatches();
};

const saveMatchTimesDiff = async (fileRaw: string) => {
  const parsedData = JSON.parse(fileRaw);

  console.log(parsedData);

  return "Match times diff saved successfully";
};

export {
  getSiteLinks,
  saveSiteLink,
  getSites,
  getMatches,
  getComparedMatches,
  saveMatchTimesDiff,
};
