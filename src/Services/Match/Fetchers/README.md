# Match Fetchers

Fetches the match list from three betting sites and reduces all of them to the
**same** JSON shape:

```json
{
  "FUTBOL": {
    "Türkiye - Süper Lig": {
      "2026-09-18": [
        { "eventId": "…", "leagueId": "…", "home": "…", "away": "…", "time": "20:00" }
      ]
    }
  },
  "BASKETBOL": { }, "VOLEYBOL": { }, "TENIS": { }
}
```

The `FUTBOL`, `BASKETBOL`, `VOLEYBOL` and `TENIS` keys are **always present, even
when empty** — existing consumers (`compare-match-times.js`, `Match.service.ts`,
the panel UI) rely on them. New sports are appended *after* them.

## Directory layout

```
Core/        site independent infrastructure
  http.js      HTTPS with a keep-alive pool + cookie jar + retry + size limit
  ws.js        RFC 6455 WebSocket (+ optional permessage-deflate)
  async.js     bounded concurrency, exponential backoff, rate limiter
  output.js    the shared output model (dedup + sorting)
  runner.js    the fetcher shell (file writing, summary, empty-result guard)
  time.js      from three different time units to Turkish time
  text.js      HTML entity / tag / attribute parsing, name normalisation
Sports/
  catalog.js   THE single source of sport mapping
*-match-fetcher.js   site specific protocol and parsing
__tests__/           fixture based tests (no network access)
```

Site specific behaviour is deliberately left in the fetcher files; `Core/` only
holds work that is genuinely identical across all three.

## Protocols

| Site | Transport | Sport discovery |
|---|---|---|
| **BETIST** | HTTPS + HTML scraping | the `home.php` menu (a request we already make) |
| **VIRUS_BET** | WebSocket, BetConstruct "swarm" JSON | a single sport/league tree query |
| **MAVI_BET** | WebSocket, WAMP v2 + deflate | the `disciplinesV2` dump (already fetched during session priming) |

In all three the sport ids are **not hardcoded**; whatever the site reports is
what gets used.

## Adding a new sport

One step: add a line to the `SPORTS` array in
[`Sports/catalog.js`](./Sports/catalog.js).

```js
{
  key: "SNOOKER",        // the key in the output JSON
  id: "SNOOKER",         // the normalised in-app value
  aliases: ["snooker", "bilardo"],   // the names the sites use
},
```

Then add the **same** `id` value to the `EMatchSport` enum in
`Constants/Match.ts`. (`catalog.test.js` catches any divergence between the two,
so the test breaks if you forget.)

You **do not need to touch** the fetcher files — all three read the sport list
from the site and match it against the catalog.

### Writing aliases

Names are normalised with `foldName()` before comparison: camelCase is split,
the letter/digit boundary is split, Turkish characters are folded and
punctuation becomes whitespace. So a single alias covers several spellings:

| What the site writes | foldName result |
|---|---|
| `AmericanFootball` | `american football` |
| `Am. Football` | `am football` |
| `Formula1` | `formula 1` |
| `Santranç` | `santranc` |

`key` and `id` automatically count as aliases too.

### Before you add one

Verify the sport **really** exists on the site. A sport with no catalog entry is
skipped silently and listed in a single line under
`MATCH_FETCHER_LOG_LEVEL=debug`:

```
[VIRUS_BET] skipped sports missing from the catalog: Counter-Strike 2, Politics, …
```

Do not add a sport you do not see in that list — that site does not offer it.

## Environment variables

All of them are optional.

| Variable | Default | Description |
|---|---|---|
| `MATCH_SPORTS` | *(all)* | Comma separated list; accepts a key or an id. Old behaviour: `FUTBOL,BASKETBOL,VOLEYBOL,TENIS` |
| `MATCH_FETCHER_LOG_LEVEL` | `info` | `silent` / `error` / `warn` / `info` / `debug` |
| `BETIST_LOG_LEVEL` etc. | — | Override the level for one site |
| `MATCH_FETCH_INTERVAL_MS` | `120000` | Wait between rounds |
| `{SITE}_CONCURRENCY` | 3 / 3 / 2 | Concurrent request limit |
| `{SITE}_REQUEST_DELAY_MS` | 150 / 120 / 80 | Minimum gap between requests |
| `{SITE}_RETRY_ATTEMPTS` | 3 | Number of attempts |
| `MAVIBET_BULK_TIMEOUT_MS` | `120000` | Timeout for the bulk sport dump |

Concurrency and delay work together: the first is "how many requests at once",
the second is "how many requests per second". Raising both can trip anti-bot
measures.

## Tests

```bash
npm test
```

The tests do not reach the network; the fixtures are trimmed real responses.
