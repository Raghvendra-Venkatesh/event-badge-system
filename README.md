# Event Badge & Scan System

A web application for importing event participants, generating QR-code badges, scanning attendance, and reviewing/exporting scan logs.

## Data safety and dates

- Participant and scan data is stored in PostgreSQL, not browser storage. Refreshing a page or redeploying the app does not clear it.
- Scan times are stored as timezone-aware timestamps. The event's IANA time zone (default `Asia/Kolkata`) controls the “today” scan rules and the time shown in the admin and scanner pages.
- The trash button archives a participant. It stops them from scanning but keeps their participant record and scan history; archived participants can be restored from the Participants page. There is no bulk-wipe action or automatic data cleanup.
- Uploaded badge artwork and generated PDFs are stored under `DATA_DIR` and `EXPORTS_DIR`. On Render, mount a persistent disk at `/var/data`.

## Deploy on Render

The included `render.yaml` provisions a Render web service, PostgreSQL database, and persistent disk. The app requires a paid web service and database plan to keep the disk and database durable.

1. Push the `main1` branch to GitHub and create a Render Blueprint from the repository using `render.yaml`.
2. Set `OPERATOR_PASSWORD` in Render to a strong password of at least 12 characters. Render generates `SESSION_SECRET`; keep it private. The application requires operator sign-in before serving pages, APIs, scan logs, or WebSocket updates.
3. Wait for the service health check to pass, then open its Render URL and sign in. Browser camera scanning uses Render's HTTPS endpoint.
4. In Settings, set the event date and its IANA time zone (for example `Asia/Kolkata` or `America/New_York`). Configure PostgreSQL backups and periodically test a restore. Back up files on the persistent disk separately; database backups do not include badge images or generated PDFs.

Render terminates HTTPS and forwards requests to the app over its private service connection. The app listens on Render's `PORT`; do not add a separate HTTP redirect service.

## Local development

Requirements: Node.js 22.12+ and a PostgreSQL database.

Local HTTPS is optional. If needed, provide your own `TLS_KEY_PATH` and `TLS_CERT_PATH`; keep the private key outside the repository. Render terminates HTTPS in production.

```powershell
npm install
Copy-Item .env.example .env
```

Set `DATABASE_URL` to your PostgreSQL connection string and fill `OPERATOR_PASSWORD` and `SESSION_SECRET` in `.env`. Use a unique operator password and a random secret of at least 32 characters. To generate a suitable secret:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Then initialize and run the app:

```powershell
npm run setup
npm start
```

Run focused tests with `npm test`.

## Migrating an existing SQLite installation

The migration command copies participants, scan history, event settings, timestamps, and badge artwork from the old SQLite database. It refuses to overwrite a PostgreSQL database that already contains participants or scans. First configure `DATABASE_URL` for the empty target database and `DATA_DIR` for a location where the source artwork can be copied, then run:

```powershell
npm run migrate:sqlite -- "C:\path\to\data\event.db"
```

The migration interprets legacy SQLite timestamps as UTC and computes each historical scan day in the configured event time zone. If the target is Render, run the migration from a trusted machine using the Render PostgreSQL external connection string and set `PGSSLMODE=require` (temporarily allowlist that machine if required). After deploying, upload the logo/background artwork again in the app so copies are present on Render's persistent disk.

## Features

- CSV/XLSX participant imports with QR code generation
- Individual and bulk print-ready badge PDFs
- QR scanning with check-in, checkout, lunch, and kit rules
- Live scan updates over authenticated WebSockets
- Participant and scan-log exports as CSV

## Project layout

- `src/server.js`: Express server, operator authentication, and WebSockets.
- `src/db.js`: PostgreSQL connection pool and transaction helper.
- `src/setup-db.js`: Idempotent PostgreSQL schema initialization.
- `src/migrate-sqlite-to-postgres.js`: One-time migration from the earlier SQLite database.
- `src/routes/`: Import, participant, scan, badge, settings, and export APIs.
- `public/`: Admin dashboard, login, and scanner pages.
- `render.yaml` / `Dockerfile`: Render deployment configuration.
