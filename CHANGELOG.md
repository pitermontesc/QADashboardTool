# Changelog

This project follows [Semantic Versioning](https://semver.org/).

## [1.21.0] - 2026-11-27

### Added
- **Installers for Apple Silicon and Intel, published as GitHub releases.** `npm run desktop:dist` builds a `.dmg` and a `.zip` per architecture (`QA-Dashboard-<version>-arm64` and `-x64`). Pushing a version tag (`v1.21.0`) runs the new **Release** workflow: it checks that the tag is the app version, runs lint, types and tests, builds the four installers on macOS and publishes the release with this CHANGELOG section as notes.
- **The app tells you when there is a new version.** It asks GitHub for the latest release 10 s after it opens and every 6 hours (no account, nothing about you). A newer one shows in the header; **Types & settings → App version** has the download for your Mac, the steps to install it (your data is kept) and what changed, and warns you to wait for runs in progress. **Help → Check for updates…** checks right away. Without a connection it says it could not check, and the app works as always.

### Changed
- The app runs on Intel Macs too.
- The user guide and the onboarding checklist install the app from the releases page.

## [1.20.0] - 2026-11-26

### Added
- **My QA profile.** A card in **Types & settings** fills in the profile the QA skills read (`~/.config/avm-qa/profile.json`) without typing JSON: **Use my Jira account** takes your name and accountId from the Jira connection, and the TC executor is found with **Search Jira by name** (active people only, no apps). It checks what is typed (a tester is needed, an accountId must look like one, the executor is whole or none) and keeps any other settings in the file. After saving, **Set up this Mac** shows the profile as ready.
- `GET`/`PUT /api/profile`, `GET /api/jira/myself` and `GET /api/jira/users?query=`.

### Changed
- **Set up this Mac** points to **My QA profile** when the profile is missing or incomplete.
- The demo keeps its QA profile in its own folder and its simulated Jira has people to search; it never touches the real profile.

### Fixed
- **Check again**, and saving the profile, could answer with a check that had started before the change (for example, the one when the app opens) and still show the old state. They now wait for it and check again.

## [1.19.0] - 2026-11-26

### Added
- **Set up this Mac.** A card at the top of **Types & settings** checks what runs with Claude need on the Mac running the app, so another QA can set it up alone: Claude Code installed (its version), signed in (`claude auth status`), the configured QA skills (against `claude plugin list --json`, with each plugin's prefix, and the personal and synced skills), Claude in Chrome connected, the QA profile (`~/.config/avm-qa/profile.json`) and Jira. What is missing says how to fix it, with the command to copy. It is checked when the app starts, every 5 minutes, with **Check again** and when you come back to the window while something is missing (about a second).
- While Claude Code is missing or signed out, the dashboard says so and links to the card.
- A configured skill that Claude Code has only under another plugin prefix is switched to that name, and the card says so.

### Changed
- **A run this Mac cannot do is refused instead of ending in BLOCKED.** Without Claude Code, signed out, or without the run's skill, the orchestrator, smoke, regression and **Validate all** answer what is missing (503) and record or queue nothing; a queued run whose turn comes then pauses its site. A check that could not be done (for example, skills on an older Claude Code) does not stop a run. Before a launch, a check older than a minute, or one that failed, is done again, so a fix counts right away.

## [1.18.1] - 2026-11-26

### Fixed
- **Demo mode: a full-coverage orchestrator run is simulated as an orchestrator run.** The simulator chose the kind of run by looking for "regression" anywhere in the prompt, and the full-coverage instructions name the regression runner, so the run ended **BLOCKED** with a regression summary. It now goes by the skill that starts the prompt. Real runs were not affected: Claude gets the prompt as it is.

## [1.18.0] - 2026-11-25

### Added
- **Full coverage for the orchestrator.** Each ticket ready for the orchestrator has a **Full** button next to **Run QA orchestrator**. The skill sizes each ticket and, on a small one (most tickets), runs only part of its team: one executor, no impact review, the regression folded into the executor. **Full** asks it for every agent whatever the size: analyst and impact review, strategist, executors, regression runner as its own agent, automation TC author and bug reporter. It takes longer (up to about 2.5 h) and uses more tokens. The report shows **Full coverage**, the run keeps it while it waits in the queue and in its automatic retry, and its tooltip shows the exact prompt. `POST /api/orchestrator/:key` takes `{fullCoverage: true}`.

### Changed
- Ticket cards are at least 262 px wide (were 250 px), so both buttons fit in Spanish.
- The user guide explains how the orchestrator sizes a ticket and which agents run at each size.

## [1.17.2] - 2026-11-25

### Fixed
- **The orchestrator always uses the `avm-qa-skills` plugin's skill.** The app launched it as `/avm-qa-orchestrator`, with no prefix, while Claude Code has two different skills with that name: the plugin's and an older copy the organization syncs (`anthropic-skills:avm-qa-orchestrator`). It now launches `/avm-qa-skills:avm-qa-orchestrator`, like the smoke and the regression. The old name, whether saved in the settings or in a backup you import, changes by itself; a skill name you chose is left alone.

## [1.17.1] - 2026-11-25

### Changed
- **No lint warnings left, and none can come back.** The 13 React warnings are fixed (`npm run lint` now fails on any warning, in CI too). What you may notice: "5 min ago", the minutes a run has been going and the dashboard's "today" now move on by themselves (every 30 seconds) instead of only when something else changed.
- Internal: the time comes from one `useNow` hook instead of being read while drawing; the settings forms follow restored data without an extra render; the report translation and the app's refresh read the current state through `useEffectEvent`. Tests now cover the forms following restored data, the Jira token box, retrying a failed translation and the notice when a run finishes.

## [1.17.0] - 2026-11-25

### Changed
- **Runs in test mode do not count in the dashboard.** A regression in test mode is a rehearsal: the cases it did not run counted as blocked and pulled the pass rate down (one rehearsal took it from 87% to 13%), and its bugs, cases and time were added too. Its run now stays in **Runs** with a **Test mode** tag and its report, but no KPI, chart or highlighted suite counts it; a line under the KPIs says how many were left out. Runs from earlier regressions in test mode are marked when the app opens or a backup is imported.

### Added
- **Test run** in the run form, to mark any run as a rehearsal (or unmark one so it counts). The CSV export has a **Test mode** column.

## [1.16.1] - 2026-11-25

### Changed
- **Electron 45.5.0** (was 45.3.4): Chromium 156.0.8078.109 with the latest security fixes from Chromium, V8, ANGLE, Dawn, FFmpeg and PDFium, plus Electron's own crash fixes. Nothing changes in how the app works.

## [1.16.0] - 2026-11-24

### Added
- **Automatic copies of the data.** The first change of each day keeps a copy of the data as it was before it (the last 14 days), and an import or a restore keeps a copy of what it replaces (the last 10). **Types & settings → Data backup** lists them with their date and how many runs and reports each has, restores one after asking (the Jira connection stays; the restore itself can be undone), and has **Back up now**. The copies live in `backups/` in the data folder and, like the data file, only your user can read them.
- **App log.** `logs/app.log` in the data folder records what the app launched, queued, skipped or paused, run results, Jira failures, imports, restores and unexpected errors with their stack (1 MB, then it rotates to `app.log.1`). The Jira token, run keys and authorization headers are never written. **Copy the last lines** (Data backup) puts its end on the clipboard to share; in the desktop app, **Help → Show the app log** and **Help → Open the data folder**.

### Changed
- **Import waits for the runs.** Importing (or restoring) while a run is in progress or queued is refused until they finish or are stopped: their results would have landed in data that no longer had them.
- Saving flushes the data to disk before replacing the file, so a crash or a power cut cannot leave it half-written.

## [1.15.2] - 2026-11-24

### Fixed
- **Numbered Jira priorities order the queue.** The AVM project names its priorities `1`…`5` (1 the most urgent, 5 the default); they were read as unknown and all counted as Medium, so priority did not change the order. Now `1`…`5` and `P1`…`P5` are read as Highest…Lowest.

## [1.15.1] - 2026-11-24

### Added
- **Smarter queue order.** Within each site: tickets last BLOCKED by the environment go last; then the most urgent Jira priority, moving up one level for every 30 days since the ticket was created; then the shortest expected run; then the oldest. Tickets of the same epic go together, and a ticket "blocked by" another one in the list goes after it. Each ticket says why it is where it is.
- **Estimates.** Each run is estimated from earlier ones (the median of runs on tickets of the same type, or of the same site for smoke and regression; BLOCKED runs do not count). **Validate all** shows the total and when each site would be free; the Run queue card shows when each run should start.
- **The queue protects itself.** A queued ticket BLOCKED by the environment (site, login, browser, or Claude ending without a report) is retried once at the end. Two runs in a row BLOCKED by the environment pause that site, and Claude's usage limit pauses every site with runs waiting, each with the reason and a **Resume** button.
- **Batch summary.** When everything queued with one click is done: **Queue finished: 4 PASSED · 1 FAILED · 1 BLOCKED · 2 h 10 min** (a retried ticket counts once).
- Jira tickets now carry their epic (parent) and the tickets they are blocked by.

## [1.15.0] - 2026-11-24

### Added
- **One run at a time per site.** Two Claude runs on the same site shared Chrome, the test users and the data, and got in each other's way. Now each QA site is a lane: a run asked for while its site is busy (another ticket, a smoke test or the regression) waits in that site's queue and starts on its own 30 s after the site is free. QA and STG still run in parallel. The ticket card or suite button shows **Queued · #N**, and the header how many are queued.
- **Validate all.** A **Validate all (N)** button next to **Refresh from Jira** lists the tickets ready for the orchestrator, per site (STG first) and in the order they would run: most urgent Jira priority first, then the oldest ticket. Tickets never validated, or last BLOCKED, are checked by default; nothing starts until you confirm.
- **Run queue card** on the dashboard: what is running and waiting on each site, with buttons to move a run up or down or take it out.
- The queue is saved and survives closing the app. When its turn comes, a ticket that left its Jira status is taken out of the queue saying why; if Claude Code cannot start, that site's queue pauses with a **Resume** button.
- Jira tickets now carry their priority and creation date (used to order the queue).

### Development
- **CI on GitHub Actions**: every push to `main` and every pull request runs lint, typecheck, the tests with a coverage floor, and the build.
- **Lint** with Oxlint (`npm run lint`, rules in `.oxlintrc.json`) and **coverage** with `npm run test:coverage` (floor just under today's 75% of statements).
- **README**: the API table lists every route (9 were missing), and a test keeps it in sync with the server. The opening instructions say how to allow the unsigned app on current macOS (**Privacy & Security → Open Anyway**; right-click → Open no longer does it) and that it runs on Apple Silicon only.

## [1.14.1] - 2026-11-24

Interface fixes from the code review.

### Fixed
- **Unsaved edits in Sites & skills are kept.** Saving any other setting (the theme, the language, a test type) wiped what you had typed in **Sites & skills** but not saved yet. Now the draft only follows the saved sites when those change.
- **A background refresh can no longer undo what you just did.** While Claude runs something, the app refreshes every 10 s; an answer that arrived after you deleted a run could bring it back, and one that arrived late could undo a finished run and announce its result twice. Now a refresh that was asked before a change is dropped, and the next one brings the news. Posting the Jira comment or editing a report's bugs no longer overwrites a refresh that arrived meanwhile.
- **Stop does not stay on "Stopping…".** If stopping failed (for example, the app could not be reached), the button stayed disabled until the report was reopened. Now it goes back to **Stop**, and the report always reloads, so a run that reported just before shows its result.
- **Retry in the assistant asks once.** It sent the failed question twice in the conversation Claude received.
- **Focus returns after a dialog.** Closing the run form, the regression dialog or a QA report (with the button or Esc) puts focus back on the button that opened it, instead of the top of the page.
- **Spanish**: a run in progress says **En curso** in the header, the cards and the report (it said "Running"), and counts read naturally in the singular ("1 ticket cargado", "Respaldo importado: 1 registro", "1 reportado").

## [1.14.0] - 2026-11-24

Security and data fixes from a code review.

### Security
- **Only the app's own page can use the local API.** Before, any page on `localhost` (any port, for example a dev server) could launch a real regression with a single request. Now the `Origin` must be the app's own, every change must be sent as JSON (which a browser cannot do across origins without a preflight the server never approves), and the app cannot be framed (`X-Frame-Options: DENY` and a Content-Security-Policy).
- **Results need the run's report key.** Each Claude run gets a secret key in its report URL (`…/result/<key>`, in the path so an unquoted curl in zsh still works). A result without it is refused, so another program cannot post a fake verdict or a Jira comment for you to publish. The key is stored only as a hash and never reaches the UI.
- **The Jira token stays with its site.** Changing the Jira site drops the saved token unless you enter a new one, and the site must be `https://`.
- **Desktop app**: a link that only looks like the app's address (`http://127.0.0.1:8765@other.site`) is no longer opened inside the app, and only `http(s)` links go to the browser.
- **CSV export**: text that a spreadsheet would run as a formula (starting with `=`, `+`, `-` or `@`, for example a title copied from Jira) is exported as text.

### Fixed
- **QA reports are no longer deleted.** Only the last 30 were kept; older ones disappeared without notice. Now every report is kept, and **Export backup (JSON)** includes them (importing an older backup without reports keeps the current ones).
- **Runs left "in progress" close on their own.** If the app was closed or crashed while Claude ran, the run stayed in progress forever and blocked new runs on the same site or ticket. Now the app checks those runs at startup and every 30 s: if Claude is gone, the run is closed as BLOCKED saying why, and one past the 4-hour limit is stopped.
- **Stop is safer and final.** A saved process id is only signaled if it is still a Claude process (ids get reused after a restart), and a run that ignores the stop is killed after 10 s, so it cannot keep working after it shows BLOCKED.
- **Translations no longer get stuck.** If Claude Code was not found, the translation queue stopped for good and "Translating…" never ended; a failed translation now only affects its own report. An early exit of `claude` can no longer crash the server.
- Importing a backup in another language translates its texts like a language change does.

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
