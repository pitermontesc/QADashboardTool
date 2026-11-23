# Changelog

This project follows [Semantic Versioning](https://semver.org/).

## [1.13.8] - 2026-11-23

### Changed
- **Runs stays fast with thousands of runs**: the list draws the first 100 runs and **Show 100 more** adds the next ones, with "Showing 100 of …" next to it. Search and filters still look at every run, and changing a filter starts again from the first 100. With 5,000 runs, opening Runs went from ~600 ms to ~25 ms, and the list no longer freezes the window for ~70 ms every 10 s while Claude runs something.

## [1.13.7] - 2026-11-23

### Fixed
- **Runs with filters that match nothing** now say "No runs match the filters." instead of "No runs yet…".
- **Test type colors are readable in both themes**: type names and tags are lightened in dark mode and darkened in light mode, so every color reaches at least 4.5:1 contrast (Accessibility and UAT were nearly invisible in dark mode).
- **Run regression dialog**: the subtitle wraps instead of being cut off, and names the site set in **The regression runs on** (for example "STG (staging.alpinevm.com)") instead of always saying staging. The test run example now shows a `/launch/` link, like testomat.io's.
- **Web version at narrow widths**: below 820px the header drops the title and the DEMO badge, so **New run** no longer goes off-screen.
- **Types & settings**: each test type's run count and "in use" line up with its name, and the hint under **Test run domains** is no longer bold.
- **Dashboard**: **Activity per day** and **By test type** have the same height.

## [1.13.6] - 2026-11-20

### Added
- **Regression in test mode**: the Run regression dialog has a **Test mode: read-only in Jira and testomat.io** checkbox. Claude validates the test cases in the browser as usual, but creates nothing in Jira (no epic, suite tasks, bugs or comment) and marks no results in testomat.io; it notes in the report what it would have created. The run is titled "Regression … (test mode)", the report shows a test-mode notice, and a Jira comment Claude prepared anyway is never offered for posting.

## [1.13.5] - 2026-11-20

### Changed
- **A bug found on more than one site counts once**: the dashboard's **Bugs found** counts each Jira key once, even when several reports list it (for example, the same bug on QA and on STG, or a repeated smoke). Bugs without a key are counted as each run reports them, and each run keeps its own count in Runs.
- In a QA report, a bug that another report also lists shows **Also in Smoke QA · 11/19**.
- Smoke, regression and orchestrator runs are asked to report a bug that is already in Jira with its existing key and link instead of as a new one.

## [1.13.4] - 2026-11-20

### Added
- **Edit the bugs of a QA report**: once a run has finished, **Edit** in "Bugs found" lets you change each bug's Jira key, severity, module, title and link, and add or remove bugs. With only a key, the link is built from your Jira site; changing the key updates a link that pointed to the old one, and a link typed by hand is kept. The original report and its translation get the same bugs (untouched texts keep each language's wording), and the run's bug count follows the list unless it had been changed by hand.

## [1.13.3] - 2026-11-19

### Fixed
- **Sites & skills table** in a half-width card: the "Environment" and "Jira status" headers overlapped and "Remove" was cut to "Remov". Columns are now sized for their headers in both languages, headers shrink a little when the window is narrow, and removing a site is a trash icon (with its name in the tooltip), like the actions in Runs.
- **Claude Code skill fields** no longer cut long names such as `/avm-qa-skills:avm-regression-runner`: they are laid out at most two per row, so the whole name fits.
- **Header at narrow windows**: in Spanish, at the app's minimum width (900 px), the "Nuevo registro" button stuck out of the header. Below 1080 px it now shows only its + icon (same name for screen readers and in its tooltip).

## [1.13.2] - 2026-11-19

### Changed
- **The whole project is written in English**: code, comments, tests, server messages, internal prompts, documentation and file names (`docs/USER-GUIDE.md`, `docs/DEMO.md`, `docs/NEW-QA-ONBOARDING.md`, `Start QA Dashboard.command`, the screenshots in `docs/img/`). The app still works in English and Spanish: Spanish lives only in the UI translations.
- Server error messages are written in English and translated to Spanish when the app is in Spanish; users see the same messages as before.

## [1.13.1] - 2026-11-19

### Added
- **Checklist for onboarding a new QA** in `docs/NEW-QA-ONBOARDING.md`: what the person inviting prepares, what the new QA installs and sets up (Claude Code, Claude in Chrome, skills, their QA profile, Jira and sites) and a final check.

### Changed
- The dashboard section **Claude runs** is renamed **Automated QA runs**: the name says what they are (smoke, regression and ticket validation), not which tool runs them.

## [1.13.0] - 2026-11-19

### Added
- **Configurable sites and skills** in **Types & settings → Sites & skills**: the sites where you test (name, URL, environment and the Jira status whose tickets are validated there), the regression site, the accepted test run domains and the Claude Code skills for the orchestrator, the smoke test and the regression. They used to be hard-coded (QA and STG on alpinevm.com, On QA / On Staging, testomat.io and the AVM skills); those are now the defaults. The smoke test shows one button per site, and the assistant knows the configured sites.

### Changed
- Runs of a smoke test or a regression on STG take the site's environment (**STG**); before, they were saved as "Staging" even when that environment was not in the list.
- In **Runs**, the row actions are icons (report, edit, duplicate, delete) with their name on hover; they no longer get cut off at narrow widths.

### Fixed
- Visual review of the UI at 1100, 1320 and 1600 px:
  - Cards no longer stretch to the height of their neighbor (Test types in settings, By test type on the dashboard).
  - The rows of **Claude runs** are aligned.
  - Run notes use the width of their column, and long URLs wrap.
  - The header no longer overflows at 1100 px.

## [1.12.0] - 2026-11-19

### Added
- **Claude assistant.** A chat panel (**Assistant** button in the header, `⌘K` or **View → Claude assistant**) that answers questions about your runs, Jira tickets and Claude run reports, and proposes actions: launch the smoke test or the regression, run the orchestrator on a ticket, create a run, post the pending Jira comment or open a report. Each action runs only after you confirm it. It uses Claude Code with your session (no API key), without tools, and never receives the Jira token or email. Actions the app could not perform (a ticket that is not loaded, a comment already posted…) are discarded before they are shown. In the demo, the assistant is simulated.

### Fixed
- The header no longer splits "QA Dashboard" or the tabs over two lines while a run is in progress; at narrow widths, the assistant button shows only its icon.

## [1.11.1] - 2026-11-19

### Changed
- **Claude's report is no longer rejected over formatting details.** Text over the limit (summary, notes, modules, steps, bugs, Jira comment) is trimmed with "…"; numbers sent as text (`"7"`, `"12.4"`) are accepted, and an empty text counts as no data; very long lists are shortened (up to 100 modules, 500 steps per module and 200 bugs). Values that are not numbers, negative values, links that are not http(s) and verdicts that do not apply are still rejected. The run form keeps its validations.

### Fixed
- A long summary made the run notes (verdict + summary + link) go over the limit, and the result was rejected.

## [1.11.0] - 2026-11-19

### Added
- **Dark mode on demand.** **Automatic** (follows macOS), **Light** or **Dark** theme, from the header button, **Types & settings → Appearance** or the **View → Appearance** menu of the desktop app. It is saved with the settings, applied on launch without a light flash, and the app window follows it. Before, dark mode was only enabled with the macOS one.

### Fixed
- In dark mode, the orchestrator button text on hover and the DEMO badge text had low contrast.
- Cases the API accepted when it should not have (found with edge case tests):
  - Dates that do not exist (`2026-02-30`), which ended up on another day in the charts.
  - Runs with a test type that does not exist, also inside an imported backup.
  - Removing a type that has runs, or repeating a type id, through the API (the UI already prevented it).
  - A verdict that does not apply to the run, for example PASSED on a smoke test.
  - Two simultaneous clicks on **Post on Jira** posted the comment twice.
  - Launching the same smoke test, regression or ticket orchestrator while it was already running started another Claude on the same thing; now it responds "There is already a run in progress". Another site or another ticket can still run at the same time.
  - In the Jira comment, a stray asterisk (`2*3*4`) turned into bold, and Markdown `*italics*` were not converted.

## [1.10.0] - 2026-11-18

### Added
- **Demo mode.** `npm run demo` (or **Help → Open demo (sample data)** in the desktop app) opens the app with sample data: Jira tickets, a month of runs and Claude runs with their QA report, in English and Spanish. Jira, Claude and translation are simulated: a smoke, regression or orchestrator launched in the demo runs for about 40 seconds with its Running indicator, its live activity and its report, without touching real data or posting anything. The header shows the **DEMO** badge.
- **Demo script** in `docs/DEMO.md`, to present the tool in about 10 minutes.

### Fixed
- The errors "Claude Code was not found" and "Could not start Claude Code" now also appear in English.

## [1.9.3] - 2026-11-18

### Added
- **Already posted / Dismiss** on a report's Jira comment: marks the draft as dismissed when another comment was already posted on the ticket, so it is not posted twice. **Restore** makes it pending again.

## [1.9.2] - 2026-11-18

### Added
- **One-click QA comment for Jira.** If Claude writes the QA comment but cannot post it (for example, because the Jira tool asks for approval and nobody can give it in the background), it leaves it in the report. There you can review it, edit it and post it with **Post on AVM-…**, using the configured Jira email and API token.

### Fixed
- **Switching to English switches everything to English.** The titles and notes the app generates (such as "Smoke STG with Claude · GO" and "Verdict GO.") and the default test types that were not renamed are translated. Reports Claude wrote in the other language (summary, modules, steps, bugs and notes) are translated in the background with Claude Haiku, once per report. The same happens when switching back to Spanish.

## [1.9.1] - 2026-11-18

### Fixed
- If Claude reports minutes with decimals (for example `4.5`), the app rounds them instead of rejecting the report; before, Claude had to fix it and send it again.

## [1.9.0] - 2026-11-18

### Added
- **QA report for each Claude run.** Clicking a run in "Claude runs" (or "Report" in Runs) opens a window with the verdict, start, end and duration, the passed/failed/blocked cases, the summary, each tested module with its steps and status, the bugs found (key, severity, module and link) and the notes. Claude sends those details in the `details` field when it finishes.
- **The app works in English or Spanish.** Switch with the EN / ES selector in the header or in Types & settings → Language. The UI, dates, error messages, the desktop app menu, the exported CSV and the runs the app creates are translated; Claude writes its reports in the chosen language.
- **"Running" on the dashboard.** While a run is in progress, the header shows **Running · Smoke STG · 6 min** (or how many are in progress), the Smoke or Regression card shows **Running** on the site button, and the ticket card shows **Running · validating**. Clicking them opens the run with its **Live activity** and a **Stop** button.

### Changed
- **Claude runs execute on their own, in the background.** Terminal no longer opens and there is no need to trust the folder or approve steps: the app launches `claude -p --chrome --permission-mode auto` in `~/qa-dashboard-runs` and saves the log in `~/qa-dashboard-runs/logs/`. If Claude finishes without reporting, the run is closed as **BLOCKED** with its last message; a run longer than 4 hours stops on its own. Dismissing a run in progress also stops it.

## [1.8.3] - 2026-11-18

### Fixed
- Claude runs open in `~/qa-dashboard-runs` instead of the home folder, where Claude Code asked to confirm trust on every run and left it stuck.

## [1.8.2] - 2026-11-18

### Fixed
- The orchestrator, the smoke test and the regression open with `claude --chrome`, so the Terminal session uses Claude in Chrome and can test in the browser. Before, it started without a browser and the run ended in BLOCKED.

## [1.8.1] - 2026-11-18

### Changed
- The header shows the RAVN logo next to "QA Dashboard", in light and dark mode.

## [1.8.0] - 2026-11-18

### Added
- Every run launched with Claude (QA orchestrator, smoke and regression) is logged in **Runs** as soon as it is launched, as "In progress", and that run is completed with the verdict, the cases and the summary when Claude reports them.
- The QA orchestrator also reports its result (PASSED, PASSED W/F, FAILED, BLOCKED) and is logged as a Functional test of the ticket.
- Smoke and regression can report **BLOCKED** when testing was not possible (for example, without a browser); before, there was only GO or NO-GO, and an untested run ended up as NO-GO.

### Changed
- The dashboard section is renamed **Claude runs** and includes the orchestrator. Dismissing an unfinished run also removes its "In progress" run.

## [1.7.0] - 2026-11-18

### Added
- Smoke and regression results reach the dashboard on their own: when it finishes, Claude reports the verdict (GO / NO-GO), the cases, the bugs and a summary to the local API, and the app creates the run. New **Smoke and regression with Claude** section with the runs in progress and finished, and a notice when a result arrives.

### Changed
- The app icon is now the RAVN logo.

## [1.6.1] - 2026-11-18

### Fixed
- **Smoke on STG** pointed to stg.alpinevm.com; it now uses the correct domain, staging.alpinevm.com.

## [1.6.0] - 2026-11-18

### Added
- **Smoke on QA** and **Smoke on STG** buttons on the Smoke suite card: they open Terminal with Claude Code running `/avm-qa-skills:avm-smoke-tester` on qa.alpinevm.com or stg.alpinevm.com.
- Jira tickets refresh on their own every 5 minutes and when you return to the window, and the app notifies you (also with a system notification) when a new ticket lands in On QA or On Staging.

## [1.5.0] - 2026-11-18

### Added
- **Run regression** button on the Regression suite card: it asks for the testomat.io test run (link or ID, optional) and opens Terminal with Claude Code running `/avm-qa-skills:avm-regression-runner`.

## [1.4.0] - 2026-11-18

### Added
- **Run QA orchestrator** button on On QA and On Staging tickets: it opens Terminal with Claude Code running `/avm-qa-orchestrator` on that ticket, in interactive mode to approve each change in Jira.

## [1.3.0] - 2026-11-18

### Changed
- Redesigned desktop experience: integrated macOS title bar, custom icon, menu with keyboard shortcuts (⌘N, ⌘1-3, ⌘F, ⌘R), and the window remembers its size and position.
- The dashboard opens with a greeting and today's summary, and puts the tickets to test first: cards with a colored status, a run counter, a direct link to Jira and a search box.
- Run form: result with colored buttons that is set automatically from the cases (failed → Failed, blocked → Blocked), ticket context, ⌘↵ to save.
- Typed notices (success or error; errors stay longer), relative dates ("updated 5 min ago"), dates in dd/mm/yyyy format, getting-started steps when there are no runs, and a revised dark mode.

## [1.2.0] - 2026-11-18

### Added
- Jira connection status on the tickets card (Not connected, Not tested, Connecting, Connected, Connection error) and a notice when the connection is established; in the desktop app, also as a system notification.
- Tickets from a Jira board: paste the board link (with its people filter) in *Types & settings → Jira connection* and the app loads its open tickets with the Agile API. The JQL becomes an extra filter.

## [1.1.0] - 2026-11-17

### Added
- Electron desktop app: `npm run desktop` opens it in its own window and `npm run desktop:pack` generates `QA Dashboard.app`.
- If an app server is already running on the port, the desktop app reuses it.

### Changed
- Data is stored in the system user data folder (macOS: `~/Library/Application Support/QA Dashboard`) instead of `./data`, so the browser and the desktop app share the same file. `QA_DASH_DATA` still allows another path.

## [1.0.0] - 2026-11-17

### Added
- Initial version: QA test logging (daily, Smoke, Regression), metrics dashboard and Jira tickets.

[1.3.0]: https://github.com/pitermontesc/QADashboardTool/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/pitermontesc/QADashboardTool/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/pitermontesc/QADashboardTool/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/pitermontesc/QADashboardTool/releases/tag/v1.0.0
