/**
 * GERIYE DONUK UYUMLULUK: eski `KNOWN_ALIASES` sabiti.
 *
 * Tek dogru kaynak artik team_aliases.json. Bu modul o JSON'dan eski
 * bicimi (foldText(alias) -> foldText(kanonik ad)) turetiyor; boylece
 * disari acilan eski API kirilmiyor ama alias'lar TEK yerde duruyor.
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
