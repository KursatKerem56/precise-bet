import { Document, ObjectId, PopulatedDoc } from "mongoose";

import { EMatchSport } from "@Match/Constants";

interface IMatch extends Document {
  site: ObjectId | PopulatedDoc<"Site">;
  sport: EMatchSport;
  leagues: IMatchLeague[];
  createdAt: Date;
  updatedAt: Date;
}

interface IMatchLeague {
  league: string;
  dates: IMatchDate[];
}

interface IMatchDate {
  date: string;
  matches: IMatchEvent[];
}

interface IMatchEvent {
  home: string;
  away: string;
  time: string;
}

export { IMatch };

/*
{
  sport: EMatchSport,
  leagues: [
    {
      league: string,
      dates: [
        {
          date: string,
          matches: [
            {
              home: string,
              away: string,
              time: string
            }
          ]
        }
      ]
    }
  ]
}
*/
