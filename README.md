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

On macOS you can also double-click `Start QA Dashboard.command` (the first time: right-click → Open).

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

The window remembers its size and position. Drag `QA Dashboard.app` to `/Applications` and open it like any other app. It is not signed: the first time, right-click → Open. Jira links open in the browser. If `npm start` is already running, the desktop app reuses that server.

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

Tickets in **On QA** or **On Staging** have the **Run QA orchestrator** button: it runs Claude Code in the background with `/avm-qa-orchestrator <TICKET>` (requires the `claude` command and the skill installed).

The **Smoke** suite card has one button per configured site (by default **Smoke on QA** and **Smoke on STG**, against qa.alpinevm.com and staging.alpinevm.com) and the **Regression** card has the **Run regression** button. The sites, the Jira statuses that are ready for the orchestrator, the test run domains and the skills (by default `/avm-qa-orchestrator`, `/avm-qa-skills:avm-smoke-tester` and `/avm-qa-skills:avm-regression-runner`) are configured in **Types & settings → Sites & skills**. Runs execute with no window and no questions (`claude -p --chrome --permission-mode auto` in `~/qa-dashboard-runs`, with their log in `logs/`); the dashboard marks them as **Running** in the header, on the suite card or on the ticket card, and their report shows the live activity and a button to stop them. Every run launched with Claude (orchestrator, smoke, regression) appears in Runs as "In progress" as soon as it is launched; when it finishes, Claude reports the verdict to `POST /api/automation/:id/result`, and the app completes that run and shows it in the **Automated QA runs** section.

Each ticket appears as a button on the dashboard; clicking it opens a new run with the ticket and title already filled in.

## Data and security

- Everything is stored in `qa-tests.json` in the data folder (see `QA_DASH_DATA`), outside the repository; the browser and the desktop app share the same file. That file contains the Jira API token and is created with `0600` permissions.
- The server listens only on `127.0.0.1` and rejects requests with an external `Host` or `Origin`.
- The token is never sent to the UI; the API only reports whether one is saved.
- **Types & settings → Data backup** exports JSON or CSV and imports a JSON backup.

## Development

```bash
npm run dev         # server with reload + Vite at http://localhost:5173
npm test            # Vitest: logic, API and UI
npm run typecheck   # strict TypeScript, client and server
npm run build       # builds to dist/
```

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
| POST | `/api/runs` | Creates a run |
| PUT / DELETE | `/api/runs/:id` | Edits or deletes a run |
| PUT | `/api/settings` | Saves types, environments and ticket URL |
| POST | `/api/import` | Replaces the data with a backup |
| PUT | `/api/jira/config` | Saves the Jira connection |
| POST | `/api/jira/refresh` | Reloads the tickets from Jira |
| POST | `/api/assistant` | Assistant: `{messages}` → `{reply, actions}`; actions are only proposed, and the app runs them if the user confirms |
| POST | `/api/automation/:id/translate` | Translates Claude's report into the requested language (`{lang}`) |
| POST | `/api/automation/:id/jira-comment` | Posts to Jira the QA comment Claude left (optional edited `{body}`) |
