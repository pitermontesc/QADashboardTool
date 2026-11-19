# QA Dashboard demo script

A 10-minute walkthrough of the tool for the team, using the demo: sample data, with Jira and Claude simulated. Nothing you do in the demo touches your data or posts to Jira.

## Before you start

1. Open the demo:
   - In the app: **Help → Open demo (sample data)**. It opens in a separate window.
   - From the code: `npm run demo:en` (or `npm run demo` to present it in Spanish). It opens `http://127.0.0.1:8790`.
2. Check that the header shows the **DEMO** badge.
3. The demo always starts the same way: closing and reopening it resets it. If you rehearsed, restart it.

Demo data: 5 Jira tickets (4 in On QA or On Staging and 1 in Test), 23 runs from the last month and 4 finished automated QA runs with their reports: orchestrator AVM-7057 (PASSED W/F, with a pending Jira comment), smoke STG (GO), regression #b333fb92 (NO-GO, 2 bugs) and smoke QA (BLOCKED).

## Script

| Min | What you do | What you say |
| --- | --- | --- |
| 0:00 | Show the top of the dashboard. | "This is the QA day at a glance: the Jira tickets I need to test and a summary of what I've done." |
| 0:45 | Point at **Tickets to test** and the **Connected** indicator. | "Tickets come from the Jira board and refresh every 5 minutes. It tells me when a new one lands in On QA." |
| 1:30 | Click the **AVM-7068** card. Fill in 4 passed, 1 failed, 1 bug and 30 minutes. | "Logging a test takes seconds: the title and ticket are already there, and the result switches to Failed because there's a failed case." Save with `⌘↵`. |
| 2:30 | Scroll to the **Summary** and switch between 7 and 30 days. | "Runs, cases, pass rate, bugs and time for the period. The pass rate is green from 90%." |
| 3:15 | On the **Smoke** card, click **Smoke on QA**. | "This launches the smoke test with Claude. It runs in the background, in Chrome, with no Terminal and no questions." |
| 3:45 | Point at **Running** in the header and on the card, and click it. | "While it runs, I can see what it's doing: every page it opens and what it finds. I can stop it." Leave the window open for a few seconds. |
| 4:30 | Close the window and move on; the result notice arrives in about 40 seconds. | "When it finishes, Claude sends the verdict and the full report, and it's saved as a run." |
| 5:00 | Open the smoke run that just finished under **Automated QA runs**. | "The QA report: verdict, timing, every module with its steps." |
| 5:45 | Open the **regression #b333fb92** (NO-GO). | "When something fails, the module opens on its own with the failed step and its note, and the bugs are listed below with their Jira links." |
| 6:45 | Open the **AVM-7057 orchestrator** and scroll to **QA comment for AVM-7057**. | "The orchestrator validates a ticket end to end and writes the QA comment. If it couldn't post it, I review it here and post it in one click, or dismiss it if I already posted another." Click **Post on AVM-7057** twice (the second click confirms): the demo posts nothing for real. |
| 8:00 | Click **ES** in the header. | "The app works in English or Spanish, and it translates Claude's reports too." Open the regression again to show it in Spanish, then switch back to **EN**. |
| 8:45 | Go to **Runs** (`⌘2`) and search for "AVM-7068". | "Everything stays in the history: search, filter, edit, or duplicate it for a re-test." |
| 9:30 | Go to **Types & settings** (`⌘3`). | "Test types, environments, Jira, language and backup to JSON or CSV. The data stays on my Mac." |

## Common questions

- **Does Claude post to Jira on its own?** In a real run, Claude follows each skill's criteria and may create bugs or comment. If the Jira tool asks for approval, it leaves the comment in the report so you can post it in one click.
- **What do I need to use it for real?** The app, Claude Code signed in, and Chrome with the Claude in Chrome extension connected. For tickets, a Jira API token.
- **Where is my data?** In `~/Library/Application Support/QA Dashboard/qa-tests.json`, only on your Mac. The full user guide is in [USER-GUIDE.md](USER-GUIDE.md).
