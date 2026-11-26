# QA Dashboard Tool

A local app to log day-to-day tests (functional, exploratory, re-test…) and large suites (Smoke, Regression), with a metrics dashboard and Jira tickets loaded as buttons.

Written in TypeScript end to end: React UI, Node (Express) server and a domain model shared by both. The UI can be switched between English and Spanish.

> 📘 **Going to use the app?** Read the [step-by-step user guide](docs/USER-GUIDE.md), with screenshots of every screen.

## Requirements

Node.js 20 or later.

## Usage

```bash
npm install     # first time only
npm start       # builds and opens the app at http://127.0.0.1:8765
```

On macOS you can also double-click `Start QA Dashboard.command`. If you downloaded the repository as a ZIP instead of cloning it, macOS blocks the file the first time: allow it in **System Settings → Privacy & Security → Open Anyway**.

The app opens in its own window. Keep the terminal open while you use it; `Ctrl+C` closes it.

### Desktop app

```bash
npm run desktop        # builds and opens the app in an Electron window (no terminal or browser)
npm run desktop:pack   # generates release/mac-*/QA Dashboard.app
```

Shortcuts (also in the app menu):

| Shortcut | Action |
| --- | --- |
| `⌘N` or `N` | New run |
| `⌘1` `⌘2` `⌘3` | Dashboard, Runs, Types & settings |
| `⌘F` or `/` | Search runs |
| `⌘R` | Refresh Jira tickets |
| `⌘K` | Claude assistant |
| `⌘↵` / `Esc` | Save / cancel the form |

The window remembers its size and position. Drag `QA Dashboard.app` to `/Applications` and open it like any other app. The build is for **Apple Silicon Macs only** (`arm64`, the architecture of the Mac that packs it) and is **not signed**. An app you packed yourself opens directly; one you received (Slack, AirDrop, a download) is blocked the first time: allow it in **System Settings → Privacy & Security → Open Anyway**, or run `xattr -dr com.apple.quarantine "/Applications/QA Dashboard.app"`. On current macOS, right-click → Open no longer skips this check. Jira links open in the browser. If `npm start` is already running, the desktop app reuses that server.

| Variable | Purpose | Default |
| --- | --- | --- |
| `QA_DASH_PORT` | Server port | `8765` |
| `QA_DASH_DATA` | Data folder | macOS: `~/Library/Application Support/QA Dashboard` |

## Onboarding another QA

The checklist for another team member to use the app and the QA skills with their own account is in [docs/NEW-QA-ONBOARDING.md](docs/NEW-QA-ONBOARDING.md): installation, Claude Code and Claude in Chrome, their QA profile (`~/.config/avm-qa/profile.json`, so the skills assign tickets to them and not to someone else), the app settings and a final check.

## Demo

`npm run demo` (or `npm run demo:en`) opens the app at `http://127.0.0.1:8790` with sample data in a temporary folder that is reset on every start. Jira, Claude Code and translation are simulated (`src/server/demo.ts`): Claude runs write their activity step by step and report a sample result, and nothing leaves the machine. In the desktop app it is under **Help → Open demo (sample data)**. The script for presenting it is in [docs/DEMO.md](docs/DEMO.md).

## Jira tickets

In **Types & settings → Jira connection**, enter the site (`https://your-site.atlassian.net`), your email and an API token (id.atlassian.com → Security → API tokens). The default JQL loads the tickets assigned to you in the last 14 days:

```
assignee WAS currentUser() AND updated >= -14d ORDER BY updated DESC
```

To load the tickets of a **board**, paste its link in the *Board* field as you copy it from the browser, including the people filter if it has one:

```
https://your-site.atlassian.net/jira/software/projects/ABC/boards/1?filter=assignee+IN+(...)
```

The app takes the site and the filter from the link, requests the tickets from the Jira Agile API and leaves out the ones that are already done. The JQL field becomes an optional extra filter. Tickets refresh on their own every 5 minutes and when you return to the window, with a notice when a new one lands in On QA or On Staging; **Refresh from Jira** on the dashboard queries the board again right away.

Tickets in **On QA** or **On Staging** have the **Run QA orchestrator** button: it runs Claude Code in the background with `/avm-qa-skills:avm-qa-orchestrator <TICKET>` (requires the `claude` command and the skill installed). The skill sizes the ticket and, on a small one, runs only some of its agents; the **Full** button next to it asks for full coverage, every agent whatever the size (slower and uses more tokens).

The **Smoke** suite card has one button per configured site (by default **Smoke on QA** and **Smoke on STG**, against qa.alpinevm.com and staging.alpinevm.com) and the **Regression** card has the **Run regression** button. The sites, the Jira statuses that are ready for the orchestrator, the test run domains and the skills (by default `/avm-qa-skills:avm-qa-orchestrator`, `/avm-qa-skills:avm-smoke-tester` and `/avm-qa-skills:avm-regression-runner`) are configured in **Types & settings → Sites & skills**. Runs execute with no window and no questions (`claude -p --chrome --permission-mode auto` in `~/qa-dashboard-runs`, with their log in `logs/`); the dashboard marks them as **Running** in the header, on the suite card or on the ticket card, and their report shows the live activity and a button to stop them. Runs on the same site go **one at a time** (they share Chrome, the test users and the data): a run asked for while its site is busy waits in that site's queue and starts by itself 30 s after the site is free, while QA and STG run in parallel. **Validate all** queues every ready ticket per site: tickets last BLOCKED by the environment last, then the most urgent Jira priority (one level up every 30 days of age), the shortest expected run (median of earlier runs of the same ticket type) and the oldest, with each epic together and a ticket after the one it is blocked by. A ticket BLOCKED by the environment is retried once; two such runs in a row pause the site, and Claude's usage limit pauses every site with runs waiting. The queue is saved and survives a restart, and a finished batch shows a summary. Every run launched with Claude (orchestrator, smoke, regression) appears in Runs as "In progress" as soon as it is launched; when it finishes, Claude reports the verdict to `POST /api/automation/:id/result`, and the app completes that run and shows it in the **Automated QA runs** section.

Each ticket appears as a button on the dashboard; clicking it opens a new run with the ticket and title already filled in.

## Data and security

- Everything is stored in `qa-tests.json` in the data folder (see `QA_DASH_DATA`), outside the repository; the browser and the desktop app share the same file. That file contains the Jira API token and is created with `0600` permissions.
- The server listens only on `127.0.0.1` and only answers its own page: it rejects requests with an external `Host` or with an `Origin` other than its own (another local port included), refuses changes that are not JSON, and sends `X-Frame-Options: DENY` and a Content-Security-Policy.
- Each Claude run gets a secret report key in its report URL (`/api/automation/<id>/result/<key>`); a result without that key is refused. The key is stored only as a hash and never reaches the UI.
- The Jira token is kept only for the site it was saved for (the site must be `https://`).
- The token is never sent to the UI; the API only reports whether one is saved.
- **Types & settings → Data backup** exports JSON or CSV and imports a JSON backup.
- **Automatic copies:** the first change of each day copies `qa-tests.json` to `backups/` in the data folder (the last 14 days are kept), and so do an import and a restore (the last 10 of those). They hold the Jira token too, so they are `0600` like the data file. The same card restores a copy or takes one by hand. Saving writes a temporary file, flushes it to disk and renames it, so a crash or a power cut leaves either the old data or the new, never a half-written file.
- **App log:** `logs/app.log` in the data folder records what the app launched, queued, skipped or paused, run results, Jira failures, imports and restores, and unexpected errors with their stack. It rotates at 1 MB (`app.log.1` keeps the previous one). The Jira token, report keys and authorization headers are replaced with `<hidden>`/`<key>` before anything is written. **Help → Show the app log** opens it in Finder; **Data backup → Copy the last lines** copies the end to share it. Each Claude run still has its own step log in `~/qa-dashboard-runs/logs/`.

## Development

```bash
npm run dev         # server with reload + Vite at http://localhost:5173
npm test            # Vitest: logic, API and UI
npm run test:coverage  # the same, with coverage (HTML report in coverage/); fails below the floor in vite.config.ts
npm run typecheck   # strict TypeScript, client and server
npm run lint        # Oxlint (rules in .oxlintrc.json): errors fail, warnings are reported
npm run build       # builds to dist/
```

**CI.** Every push to `main` and every pull request runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml) on GitHub Actions: lint, typecheck, tests with the coverage floor, and the build. The coverage report is attached to the run as an artifact. The desktop app is not packed in CI (it is packed on a Mac with `npm run desktop:pack`).

### Structure

```
src/
  shared/    Domain model and pure logic (types, dates, statistics)
  server/    REST API: validation (zod), persistence, Jira client
  desktop/   Electron main process (desktop window)
  client/    React UI
tests/       Statistics, API (real server on a temporary port) and UI (jsdom)
```

### Decisions

- **Persistence in a JSON file** with atomic writes instead of a database: there are only a few runs per day, and this way there are no native dependencies to compile. `Store` isolates access in case it is worth changing some day.
- **Validation at the edge:** every API input goes through zod schemas; the rest of the code works with already validated types.
- **Pure metrics logic** in `src/shared/stats.ts`, with no React or Node dependencies, so it can be tested in isolation.
- **Injectable Jira:** the server receives the `fetch` function, so tests simulate Jira without network access.

### API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/state` | Settings, runs and Jira status |
| POST | `/api/runs` | Creates a run (`testMode: true` marks a rehearsal: listed, but left out of the dashboard's numbers) |
| PUT / DELETE | `/api/runs/:id` | Edits or deletes a run |
| PUT | `/api/settings` | Saves the settings: types, environments, ticket URL, language, theme, and sites & skills |
| POST | `/api/import` | Replaces the data with a backup (and the QA reports, if the backup has them). A copy of the current data is kept first; 409 while a run is in progress or queued |
| GET / POST | `/api/backups` | Lists the automatic copies of the data (`{dir, items}`, newest first; `dir` shows the home folder as `~`), or takes one now |
| POST | `/api/backups/:name/restore` | Restores the runs, reports and settings of a copy (the Jira connection is kept); a copy of the current data is kept first; 409 while a run is in progress or queued |
| GET | `/api/log` | The last 300 lines of the app log (`{file, lines}`) |
| PUT | `/api/jira/config` | Saves the Jira connection |
| POST | `/api/jira/refresh` | Reloads the tickets from Jira |
| POST | `/api/orchestrator/:key` | Launches the QA orchestrator on a loaded ticket, on the site its Jira status maps to (409 if the status is not ready or the ticket is already running or queued). Optional `{fullCoverage: true}` runs every agent of the skill whatever the ticket size. Like smoke and regression: 200 with the run, or 202 `{queued, position}` if its site is busy |
| POST | `/api/smoke` | Launches the smoke test on a site (`{site}`, a site id from Sites & skills) |
| POST | `/api/regression` | Launches the regression (`{run}` test run link, optional `{dryRun: true}` for test mode: nothing is created or marked) |
| POST | `/api/queue` | "Validate all": queues the given tickets (`{keys}`), each on its site, in the app's order; returns the state |
| DELETE | `/api/queue/:id` | Takes a run out of the queue |
| POST | `/api/queue/:id/move` | Moves a queued run one place within its site (`{direction: "up" \| "down"}`) |
| POST | `/api/queue/resume` | Resumes a site's queue paused because Claude could not start (`{site}`) |
| POST | `/api/automation/:id/result/:key` | Claude reports the run's result (verdict, summary, details). `:key` is the run's report key from its prompt; without it the result is refused (403) |
| GET | `/api/automation/:id/activity` | What Claude is doing: steps read from the run's log, and the log path |
| POST | `/api/automation/:id/stop` | Stops a run in progress; it is closed as BLOCKED (409 if it already has a result) |
| DELETE | `/api/automation/:id` | Deletes a QA report (stopping its run and removing its "In progress" run first, if it had not finished) |
| PUT | `/api/automation/:id/bugs` | Edits the bugs of a finished report (`{lang, bugs}`) |
| POST | `/api/assistant` | Assistant: `{messages}` → `{reply, actions}`; actions are only proposed, and the app runs them if the user confirms |
| POST | `/api/automation/:id/translate` | Translates Claude's report into the requested language (`{lang}`) |
| POST | `/api/automation/:id/jira-comment` | Posts to Jira the QA comment Claude left (optional edited `{body}`) |
| POST | `/api/automation/:id/jira-comment/dismiss` | Dismisses the Jira comment, or restores it with `{dismissed: false}` |
