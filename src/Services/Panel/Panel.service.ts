import fs from "node:fs/promises";

import {
  getMatches as _getMatches,
  getComparedMatches as _getComparedMatches,
} from "@Match";

import {
  updateFetcherStatus as _updateFetcherStatus,
  getFetcherStatus as _getFetcherStatus,
} from "@Panel/Redis";

import { PanelSite } from "@Panel/Models";

import { EPanelSite } from "@Panel/Constants";

import { AppError } from "@Utils/Error";
import { logger } from "@Utils/Logger";
import axios from "axios";

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
  logger.info("Saving match times diff to file...");

  const jsonFilePath = `./match-times-diff.json`;

  await fs.writeFile(jsonFilePath, fileRaw, "utf-8");

  logger.info("Match times diff saved to file successfully");

  return "Match times diff saved successfully";
};

const updateFetcherStatus = async (status: string) => {
  return await _updateFetcherStatus(status);
};

const getFetcherStatus = async () => {
  return await _getFetcherStatus();
};

const asdasd = async () => {
  const arr = new Array(100000).fill(0).map((_, i) => i + 1);

  for (const i of arr) {
    const response = await axios.get("https://umayyazilim.com");
    console.log(response.data);
  }
};

export {
  getSiteLinks,
  saveSiteLink,
  getSites,
  getMatches,
  getComparedMatches,
  updateFetcherStatus,
  saveMatchTimesDiff,
  getFetcherStatus,
  asdasd,
};
