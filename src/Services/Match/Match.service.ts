import { getSites } from "@Panel";

import { Match } from "@Match/Models";

import { EMatchSport } from "@Match/Constants";

const test = async () => {
  return "Match service is working";
};

const saveTempMatches = async () => {
  // const site = (await getSites()).find((site) => site.site === "BETIST");
  // if (!site) return;
  // const matchesWillBeSaved = [];
  // for (const sportKey of Object.keys(matchesRaw) as Array<
  //   keyof typeof matchesRaw
  // >) {
  //   const sport = matchesRaw[sportKey];
  //   const data = {
  //     site: site._id.toString(),
  //     sport:
  //       sportKey === "FUTBOL"
  //         ? EMatchSport.FOOTBALL
  //         : sportKey === "BASKETBOL"
  //           ? EMatchSport.BASKETBALL
  //           : sportKey === "VOLEYBOL"
  //             ? EMatchSport.VOLLEYBALL
  //             : EMatchSport.TENNIS,
  //     leagues: [],
  //   };
  //   for (const leagueKey of Object.keys(sport) as Array<keyof typeof sport>) {
  //     const league = sport[leagueKey];
  //     const leagueData = {
  //       league: leagueKey,
  //       dates: [],
  //     };
  //     for (const dateKey of Object.keys(league) as Array<keyof typeof league>) {
  //       const date = league[dateKey];
  //       const dateData = {
  //         date: dateKey,
  //         matches: [],
  //       };
  //       for (const match of date) {
  //         const matchData = {
  //           home: match.home,
  //           away: match.away,
  //           time: match.time,
  //         };
  //         dateData.matches.push(matchData);
  //       }
  //       leagueData.dates.push(dateData);
  //     }
  //     data.leagues.push(leagueData);
  //   }
  //   matchesWillBeSaved.push(data);
  // }
  // for await (const matchData of matchesWillBeSaved) {
  //   await Match.create(matchData);
  // }
};

export { test, saveTempMatches };
