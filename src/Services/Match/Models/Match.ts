/* eslint-disable @typescript-eslint/no-explicit-any */
import { Schema, model } from "mongoose";

import { IMatch } from "@Match/Types";

import { EMatchSport } from "@Match/Constants";

const MatchSchema = new Schema<IMatch>(
  {
    site: { type: Schema.Types.ObjectId, ref: "Site", required: true },
    sport: { type: String, enum: Object.values(EMatchSport), required: true },
    leagues: [
      {
        league: { type: String, required: true },
        dates: [
          {
            date: { type: String, required: true },
            matches: [
              {
                home: { type: String, required: true },
                away: { type: String, required: true },
                time: { type: String, required: true },
                _id: false,
              },
            ],
            _id: false,
          },
        ],
        _id: false,
      },
    ],
  },
  { timestamps: true }
);

export default model<IMatch>("Match", MatchSchema);
