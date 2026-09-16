# React Frontend Design Prompt

```text
You are redesigning an existing React frontend for a sports match comparison dashboard.

The backend API is already implemented. Do not change the backend contract.

API base URL:
http://localhost:3005

Authentication:
Every protected request must include:
Authorization: <AUTH_TOKEN>

The backend has these endpoints:

GET /health-check
GET /user/test
GET /user/me
GET /panel/site-links
POST /panel/save-site-link
GET /panel/matches
GET /panel/compared-matches

The main application should be a polished operational dashboard for comparing football, basketball, volleyball, and tennis matches across betting sites.

Design direction:

- Create a focused, professional sports-data dashboard.
- Use a distinctive editorial visual identity instead of a generic admin template.
- Use a strong display font for headings and a highly readable sans-serif for data.
- Use a light warm-gray background, deep charcoal text, vivid red or coral as the primary action color, and restrained green/yellow status colors.
- Avoid purple gradients, excessive rounded cards, oversized hero sections, and decorative marketing content.
- Use compact cards only for meaningful repeated data.
- Prioritize fast scanning, filtering, comparison, and clear data density.
- Make the interface responsive on desktop, tablet, and mobile.

Required views:

1. Dashboard overview
   - Total match groups
   - Comparable matches
   - Matches with different times
   - Matches with identical times
   - Site coverage summary
   - Last data update time

2. Matches view
   - Site tabs for VIRUS_BET, MAVI_BET, and BETIST
   - Sport filter
   - League filter
   - Date filter
   - Search by home or away team
   - Group matches by date and league
   - Display home team, away team, match time, sport, league, and site
   - Include loading, empty, and API error states

3. Compared matches view
   - Summary metrics from /panel/compared-matches
   - List matches with different times
   - Show the same match across available betting sites
   - Clearly highlight time differences
   - Support filtering by sport, league, date, and site
   - Display comparison confidence or matching metadata only when it exists in the API response
   - Do not invent fields that the API does not provide

4. Site settings view
   - Fetch the current site links from /panel/site-links when the view opens
   - Form for saving a site URL
   - Select site from VIRUS_BET, MAVI_BET, and BETIST
   - URL validation
   - Success and error feedback
   - Disable submit while saving
   - Pre-fill each site with its existing link when available
   - Refresh the displayed site links after a successful save

5. Authentication and API states
   - Centralize API requests in one client module
   - Read the API URL and auth token from environment variables
   - Send the exact Authorization header without adding "Bearer"
   - Show a clear unauthorized state for HTTP 401
   - Show a rate-limit state for HTTP 429
   - Add retry actions for failed requests
   - Never display the auth token in the UI
   - Never hardcode production credentials

Component requirements:

- Build reusable components for metric cards, filter bars, match rows, comparison rows, data tables, status badges, empty states, loading skeletons, and toast notifications.
- Use accessible buttons, labels, keyboard navigation, and sufficient color contrast.
- Use icons only where they improve recognition.
- Tables should become stacked readable rows on mobile.
- Keep controls stable in size so loading and long team names do not shift the layout.
- Format dates and times consistently.
- Use realistic sample data only as a fallback during loading or development; use the real API once available.

Technical requirements:

- Use React with the existing project structure and styling approach.
- Do not replace the existing build setup unless necessary.
- Keep API types separate from presentation components.
- Add TypeScript types for matches, leagues, dates, sites, sports, comparison summaries, and API errors.
- Handle malformed or partially empty API responses gracefully.
- Keep filtering client-side after fetching data unless the backend gains query parameters.
- Do not add unsupported login, pagination, sorting, or mutation features.
- Make the first screen immediately useful: show the dashboard overview and recent comparison state.
- Produce a refined, production-quality visual design with responsive behavior and polished loading, empty, success, and error states.
```
