# FalconScout 2.0

Team 4099's FRC scouting app. React + Vite frontend, Convex backend, installable
as a PWA and designed to keep working on a venue network that has a signal but no
uplink.

---

## Running it locally

```bash
npm ci
npx convex dev
```

`npx convex dev` starts a **local backend** — no Convex account needed — and
writes `CONVEX_DEPLOYMENT`, `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL` into
`.env.local`. Leave it running; it watches `convex/` and regenerates
`convex/_generated` on change.

In a second terminal:

```bash
npm run dev
```

To develop against your team's real deployment instead, run
`npx convex dev --configure` and pick the project.

### Optional: The Blue Alliance key

Team lists, rankings, match schedules and avatars all come from TBA. Without a
key those views stay empty and the app tells you so. Get a free read key from
[thebluealliance.com/account](https://www.thebluealliance.com/account), then
either paste it into **Settings → API Keys** (it syncs to your account across
devices) or set `VITE_TBA_KEY` in `.env.local`.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck, then production build into `dist/` |
| `npm test` | Full test suite (Convex functions + client libraries) |
| `npm run test:watch` | Tests in watch mode |
| `npm run lint` | ESLint — see the note below |

`npm run lint` currently reports errors from the `eslint-plugin-react-hooks` v7
rules, concentrated in `BettingPage.tsx` and `DashboardPage.tsx`. They flag
effects that could be derived state rather than active bugs. CI does not gate on
lint for that reason; it does gate on typecheck and tests.

---

## Tests

```bash
npm test
```

Two vitest projects:

- **`convex`** — Convex functions under `edge-runtime` via `convex-test`, which
  can mock an authenticated identity. This is where the authorization rules are
  pinned down.
- **`client`** — client libraries under `jsdom`. `clearAllCache` enumerates
  `localStorage` with `Object.keys`, which only behaves correctly on the real
  thing, so a hand-rolled stub is not enough.

---

## Authorization model

There are two levels, both enforced **on the server** in `convex/adminAuth.ts`:

- `requireUser` — signed in. Used for anything a scout does: submitting forms,
  syncing their offline queue, moving picklist cards.
- `requireAdmin` — signed in **and** presented the shared admin key. Used for
  destructive or team-wide operations: setting the event, editing form
  templates, deleting submissions, publishing schedules, resolving betting
  markets.

The admin credential is a single password the team shares. The client stores its
SHA-256 hash and sends that hash as `adminKey`; the plaintext never leaves the
browser. The server compares it against the hash in the `adminConfig` table,
which is seeded from the `ADMIN_PASSWORD_HASH` environment variable on first use.

Admin Mode in Settings is a UI convenience only. Turning it on by editing
`localStorage` shows the admin menu items and nothing more — every privileged
call is still rejected by the backend.

### Setting the admin password

Compute the hash and set it in the Convex dashboard (Settings → Environment
Variables), or:

```bash
node -e "crypto.subtle.digest('SHA-256', new TextEncoder().encode(process.argv[1])).then(b=>console.log(Buffer.from(b).toString('hex')))" 'your-team-password'
```

```bash
npx convex env set ADMIN_PASSWORD_HASH <hash>
```

If it is never set, the credential falls back to the hash of `passw0rd` — the
value that was hardcoded in the client for the life of the app, and therefore
public. **Settings shows a red warning while that fallback is in use.**

Changing the password from Settings → Change Admin Password updates the
`adminConfig` row for the whole team, and takes effect immediately.

---

## Deploying

Pushing to `main` runs `.github/workflows/deploy.yml`, which typechecks and
tests, then deploys the Convex backend and the Vercel frontend — in that order,
so the backend is never behind the client.

Required repository secrets:

| Secret | Used for |
| --- | --- |
| `CONVEX_DEPLOY_KEY` | Pushing schema + functions to the production Convex deployment |
| `VITE_CONVEX_URL` | Baked into the bundle so the app knows its backend |
| `VITE_CONVEX_SITE_URL` | Convex HTTP actions endpoint (OAuth callback) |
| `VERCEL_TOKEN` | Vercel CLI auth |
| `VERCEL_ORG_ID` | Vercel project targeting |
| `VERCEL_PROJECT_ID` | Vercel project targeting |

The workflow fails before building if either `VITE_*` secret is missing, rather
than shipping a bundle that cannot reach a backend.

Convex-side environment variables (set in the Convex dashboard, not GitHub):
`ADMIN_PASSWORD_HASH`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`.

### First deploy of the authorization changes

Do these once, in order:

1. **Set `ADMIN_PASSWORD_HASH`** on the production deployment (see above).
   Do this *before* deploying, so the default is never live.
2. **Deploy.** The schema adds `compLevel` to `formSubmissions`, `lastBegAt` to
   `userBalances`, and the `adminConfig` table. All new fields are optional, so
   existing rows validate as-is and no downtime is expected.
3. **Backfill comp levels** once the deploy is green:

   ```bash
   npx convex run forms:backfillCompLevel '{"adminKey":"<your hash>"}' --prod
   ```

   It returns a tally. Rows written by the online path are recovered from
   `data._matchPrefix`; rows that synced through the old offline queue never
   stored it and are left unset rather than guessed. Safe to re-run.
4. **Make everyone update the app.** Two changes are not backward compatible
   with a cached older client:
   - QR codes are now **v2** and carry the form id. The scanner rejects v1
     codes with a message telling the scout to regenerate them. Any code
     generated but not yet scanned before the update must be re-shown.
   - Older clients do not send `adminKey`, so admin actions from them fail
     until they reload.

   The app prompts to update when a new version is available; make sure every
   device takes it **before** an event, not during one.

---

## Offline behaviour

Worth knowing before changing any of it:

- Submissions are written to `localStorage` first and queued for sync, so a
  scout can work through a whole match with no connection.
- The same data is kept locally to regenerate QR codes, which is how data moves
  between phones when there is no uplink at all.
- Signing in requires a network, but a device that has signed in once keeps a
  cached viewer and renders from it when the backend is unreachable.
- **Settings → Clear Cache only clears re-fetchable API and Convex responses.**
  Queued submissions, QR backups, scanned data and the cached session are never
  touched. If you add a new `localStorage` key that holds user work, add it to
  `NEVER_CLEAR` in `src/lib/persistentCache.ts`.
