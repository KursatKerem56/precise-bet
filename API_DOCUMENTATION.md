# Precise Bet API Documentation

## Base URL

```text
http://localhost:3005
```

The base URL and port are controlled by `APP_URL` and `APP_PORT`.

## Authentication

Protected endpoints require the exact value of the backend `AUTH_TOKEN` environment variable:

```http
Authorization: YOUR_AUTH_TOKEN
```

The backend compares the header directly with `AUTH_TOKEN`. Do not prefix the value with `Bearer`.

There is currently no login or token-generation endpoint.

Example development configuration:

```env
VITE_API_URL=http://localhost:3005
VITE_AUTH_TOKEN=your-development-auth-token
```

Do not expose a long-lived production `AUTH_TOKEN` directly in a browser application. Use a server-side proxy or backend-for-frontend in production.

## Endpoints

### GET `/health-check`

Public health check.

Response: HTML

```html
<div>SERVER IS RUNNING</div>
```

### GET `/user/test`

Public test endpoint.

Response:

```json
"test"
```

### GET `/user/me`

Protected endpoint.

Headers:

```http
Authorization: YOUR_AUTH_TOKEN
```

Response: returns the current Express `req.user` value. The current authentication middleware only validates the static token and does not populate `req.user`, so this endpoint may return an empty or undefined response until user population is implemented.

### GET `/panel/site-links`

Protected endpoint.

Headers:

```http
Authorization: YOUR_AUTH_TOKEN
```

Returns the configured betting-site links.

Response:

```json
[
  {
    "site": "VIRUS_BET",
    "link": "https://example.com"
  }
]
```

The response may be an empty array when no site links have been configured.

### POST `/panel/save-site-link`

Protected endpoint.

Headers:

```http
Authorization: YOUR_AUTH_TOKEN
Content-Type: application/json
```

Request body:

```json
{
  "site": "VIRUS_BET",
  "link": "https://example.com"
}
```

Valid `site` values:

```text
MAVI_BET
BETIST
VIRUS_BET
```

Successful response:

```json
{
  "_id": "mongodb-object-id",
  "site": "VIRUS_BET",
  "link": "https://example.com",
  "createdAt": "2026-09-16T00:00:00.000Z",
  "updatedAt": "2026-09-16T00:00:00.000Z"
}
```

Possible errors:

```json
{
  "statusCode": 400,
  "locale_key": "api.error.missingParameters",
  "message": "Missing parameters"
}
```

```json
{
  "statusCode": 400,
  "locale_key": "api.error.invalid_site",
  "message": "Invalid site"
}
```

### GET `/panel/matches`

Protected endpoint.

Headers:

```http
Authorization: YOUR_AUTH_TOKEN
```

Response shape:

```json
{
  "VIRUS_BET": [
    {
      "_id": "mongodb-object-id",
      "site": "mongodb-object-id",
      "sport": "FOOTBALL",
      "leagues": [
        {
          "league": "LFPB",
          "dates": [
            {
              "date": "2026-09-18",
              "matches": [
                {
                  "home": "CD Real Tomayapo",
                  "away": "CD Oriente Petrolero",
                  "time": "20:00"
                }
              ]
            }
          ]
        }
      ],
      "createdAt": "2026-09-16T00:00:00.000Z",
      "updatedAt": "2026-09-16T00:00:00.000Z"
    }
  ],
  "MAVI_BET": [],
  "BETIST": []
}
```

Supported sports:

```text
FOOTBALL
BASKETBALL
VOLLEYBALL
TENNIS
```

### GET `/panel/compared-matches`

Protected endpoint.

Headers:

```http
Authorization: YOUR_AUTH_TOKEN
```

The response is read from `match-times-diff.json`. Its exact contents may change when the comparison process runs.

Current response shape:

```json
{
  "olusturulma": "2026-09-16T02:12:22.017Z",
  "siteler": ["virus_bet", "mavi_bet", "betist"],
  "kaynaklar": {},
  "ayarlar": {
    "toleransDakika": 0,
    "takimEsigi": 78,
    "ligEsigi": 55,
    "ligZorunlu": false,
    "tarihToleransGun": 1
  },
  "ozet": {
    "toplamMacGrubu": 3414,
    "karsilastirilabilir": 1248,
    "saatiFarkli": 152,
    "saatiAyni": 1096
  },
  "farkliMaclar": {
    "FUTBOL": {
      "LFPB": {
        "2026-09-18": [
          {
            "sport": "FUTBOL",
            "league": "LFPB",
            "date": "2026-09-18",
            "home": "Team A",
            "away": "Team B",
            "time": "20:00"
          }
        ]
      }
    }
  }
}
```

## Common Errors

### Invalid authentication: HTTP 401

```json
{
  "statusCode": 401,
  "message": "auth.error.notAuthenticated",
  "error": "auth.error.notAuthenticated"
}
```

### Rate limit: HTTP 429

The API allows approximately 600 requests per 30 seconds per client/IP.

```json
{
  "statusCode": 429,
  "locale_key": "api.error.too_many_requests",
  "message": "Too many requests, please try again later"
}
```

### General server error: HTTP 500

```json
{
  "statusCode": 500,
  "locale_key": "api.error.unexpected",
  "message": "Unexpected error"
}
```

## Backend Environment Credentials

The backend requires these categories of configuration. Only the frontend-facing token should be provided to a frontend integration, and it should be handled carefully.

```env
AUTH_TOKEN=replace-with-a-real-secret
APP_URL=http://localhost:3005
APP_PORT=3005
FRONTEND_URL=http://localhost:8080
MONGO_URI=mongodb://localhost:27017/cgg
REDIS_URI=localhost
SESSION_SECRET=replace-with-a-session-secret
```

AWS and Google reCAPTCHA configuration are also defined by the backend environment, but they are server-side credentials and must not be placed in a browser frontend.
