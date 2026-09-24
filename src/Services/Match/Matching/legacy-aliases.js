/**
 * BACKWARDS COMPATIBILITY: the old `KNOWN_ALIASES` constant.
 *
 * The single source of truth is now team_aliases.json. This module derives
 * the old format from that JSON (foldText(alias) -> foldText(canonical
 * name)), so the old public API keeps working while the aliases live in ONE
 * place.
 */

import { foldText } from "./text.js";
import { listTeamRecords } from "./aliases.js";

const build = () => {
  const out = {};

  for (const record of listTeamRecords()) {
    const canonical = foldText(record.canonical);

    for (const alias of record.aliases ?? []) {
      const key = foldText(alias);
      if (key && key !== canonical) out[key] = canonical;
    }
  }

  return out;
};

export const KNOWN_ALIASES = build();
