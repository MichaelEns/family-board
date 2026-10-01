# Family Board

A shared family calendar, chores/rewards, meals, and lists dashboard for phones,
tablets, and Echo Show. It is designed to provide the useful parts of a
Skylight Calendar without a required subscription.

## What it does

- Shows local family events and read-only iCal feeds from Google Calendar,
  Microsoft Outlook, and published iCloud calendars.
- Assigns chores to family members and attaches star rewards.
- Plans dinner for the next week.
- Keeps shared lists and list items.
- Installs as an offline-capable PWA. The last board snapshot remains readable
  when the network is unavailable; edits are retained locally and merged when
  the connection returns.
- Uses generated four-word codes instead of household passwords.
- Exposes an Echo Show APL dashboard with events, chores, and dinner.
- Publishes a persistent Alexa widget with the next event, remaining chores,
  and dinner.
- Lets one Alexa account pair several homes and switch among them by name.

The Echo Show full-screen experience is still an Alexa skill session. Amazon
retains control of the device home screen; the widget persists in the Widget
Panel, while the detailed dashboard opens when the widget is tapped or the user
says, **"Alexa, open our household board."** A tablet running the PWA is the better
target when a permanently full-screen wall board is required.

## Households and sharing

Creating a board returns an **owner code**. It can change every part of the
board, manage private calendar URLs, and create or revoke narrower codes:

- A **contributor code** can edit events, chores, meals, and lists. It cannot
  see or replace calendar-feed URLs or manage sharing.
- A **viewer code** can only read the board.

Each real household should normally create its own board. To show another
household's board as well, connect its share code as an additional board in the
Alexa skill. Data is never merged merely because the same person uses two
homes.

Example:

1. Grandma creates **Grandma's House** with its own owner code.
2. Joe's parent creates a contributor code for **Joe's Family**.
3. Grandma connects both codes to her Alexa account.
4. **"Alexa, ask our household board to switch to Joe's Family"** shows Joe's shared
   board. Switching back shows Grandma's independent events and chores.

## Concurrency and data safety

Each board is owned by a SQLite-backed Cloudflare Durable Object. All writes
for that board are serialized and merged per record inside a storage
transaction. Two homes adding different chores at the same moment preserve
both; one whole-document response cannot erase the other home's edit.

Every record carries an `updatedAt` timestamp. Newest wins only for the same
record. Separate chores, events, meals, profiles, lists, and list items do not
compete with one another.

Four-word owner/share codes remain small capability credentials. Codes are
generated from 256 words, rate-limited by source IP, and can be revoked
individually. Do not publish them.

## Calendar feeds

The board accepts private iCal URLs from:

- `calendar.google.com`
- `outlook.office365.com`
- `outlook.live.com`
- published iCloud hosts matching `p<number>-caldav.icloud.com`

The Worker rejects HTTP, embedded credentials, loopback/private destinations,
unsupported hosts, and redirects outside those providers. Responses are capped
at 2 MB. Recurring events are expanded only for the requested date range, with
a bounded occurrence count.

Calendar feeds are read-only. Add or edit provider events in Google, Outlook,
or Apple Calendar; Family Board displays the result. Locally authored Family
Board events can be edited through the PWA.

## Cost

There is no mandatory recurring monetary charge:

- GitHub Pages hosts the static PWA.
- Cloudflare Workers Free handles the API.
- Workers KV stores capability and Alexa-link mappings.
- SQLite-backed Durable Objects are available on Workers Free and serialize
  board data.
- Alexa skill publication, APL, widgets, and Data Store do not require a
  subscription.

This is subject to each provider's published free-tier limits. Cloudflare
currently includes 100,000 Durable Object requests per day, five million rows
read per day, 100,000 rows written per day, and 5 GB of storage on Workers
Free. Requests fail rather than creating a bill if a free-plan limit is
exceeded. See [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Deploy the web service

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Create the code-mapping KV namespace:

   ```powershell
   npx wrangler kv namespace create CODES
   ```

   Put the returned ID in [`worker/wrangler.toml`](worker/wrangler.toml).

3. Deploy. Wrangler creates the SQLite-backed Durable Object namespace from
   the included `v1` migration:

   ```powershell
   npm run deploy
   ```

4. Publish the repository with GitHub Pages from `main`. The production URLs
   in [`app.js`](app.js), the skill package, and `ALLOWED_ORIGINS` assume:

   - `https://michaelens.github.io/family-board/`
   - `https://family-board-sync.michaelens.workers.dev`

   Change all of them together if the deployment names differ.

## Deploy the Alexa skill

1. Create a **Custom**, **Provision your own**, **Start from scratch** skill
   named **Our Household Board**. Its invocation is deliberately
   **our household board** because another vendor already publishes a Luana
   skill invoked as **family board**.
2. Deploy [`alexa/skill-package`](alexa/skill-package), including the
   `FamilyBoardSummary` data-store package.
3. Enable APL, Data Store, Data Store Packages, and the Data Store extension.
4. Put the skill ID in [`worker/wrangler.toml`](worker/wrangler.toml).
5. Create Alexa Skill Messaging/Login with Amazon credentials for the
   `alexa::datastore` scope, then configure them as Worker secrets:

   ```powershell
   cd worker
   npx wrangler secret put ALEXA_CLIENT_ID
   npx wrangler secret put ALEXA_CLIENT_SECRET
   npx wrangler deploy
   ```

6. Enable development testing, connect a test board, install the widget, and
   test touch updates on an Echo Show.
7. Publish/certify the skill for durable access from different Amazon accounts.
   Alexa beta testing is suitable only for a time-limited trial.

## Tests

```powershell
npm test
npm run check
node tests/browser.cjs "<path to msedge.exe>"
```

The browser journey runs the real PWA against the real Worker module and proves
board creation, people, chores/rewards, meals, lists, local events, and reload
persistence. Unit/integration coverage separately verifies access roles,
simultaneous multi-home edits, calendar URL policy and recurrence, Alexa touch
authority, widget packaging, and outbound browser boundaries.
