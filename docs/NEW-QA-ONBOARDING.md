# Checklist: onboarding a new QA

For another team member to use QA Dashboard and the AVM QA skills with their own account. There are two parts: what the person inviting them prepares, and what the new QA does on their Mac. At the end, a check confirms that everything is set up correctly.

## 1. The person inviting

- [ ] **Skills published in the organization.** The `avm-qa-skills` 2.0.0 plugin (it includes the orchestrator) is already in the organization library and is not tied to anyone: each QA uses their own profile. Send them the link: <https://claude.ai/customize/plugins/plugin_01W7CGiL5o3doWhowWcddeqT>.
- [ ] **App.** Send them `QA Dashboard.app` (Apple Silicon Macs only for now) or access to the repository.
- [ ] **User guide.** Share the published guide from its **Share** menu. The app and the guide are available in English and Spanish.
- [ ] **Information they will need:**
  - the link to the team's Jira board;
  - who runs the TCs when a ticket passes QA (the "TC executor", currently Paulo Sanchez), with their Jira accountId;
  - the QA and STG test users they can use.

## 2. The new QA, on their Mac

### Installation

- [ ] **App.** Drag `QA Dashboard.app` to **Applications** and open it. It is not signed, so the first time macOS blocks it: in **System Settings → Privacy & Security**, click **Open Anyway**.
- [ ] **Claude Code.** Install it, run `claude` once in Terminal and sign in with your account. Runs use **your** plan.
- [ ] **Chrome and Claude in Chrome.** Install the extension, connect it to your Claude account and sign in with **your user** on `qa.alpinevm.com`, `staging.alpinevm.com` and `app.testomat.io`. Without this, runs end in BLOCKED.
- [ ] **Skills.** Install the `avm-qa-skills` plugin from the organization library in one of these ways:
  - on claude.ai: <https://claude.ai/customize/plugins/plugin_01W7CGiL5o3doWhowWcddeqT>;
  - in Claude Code: add the organization library under `/plugin` → **Marketplaces** and run `/plugin install avm-qa-skills@claudeai-organization-library`.

  Check with `/skills` in Claude Code that `avm-qa-orchestrator`, `avm-smoke-tester`, `avm-regression-runner`, `avm-qa-validator` and the rest are listed. The app checks it too, in **Types & settings → Set up this Mac**.
- [ ] **Atlassian connector in Claude.** Connect it in claude.ai → Connectors. If the organization requires approval to post to Jira, Claude cannot comment from a background run; the app keeps the comment ready to post in one click.

### Set up the app

- [ ] **Jira.** In **Types & settings → Jira connection**: your email, **your own API token** and the board link. If the board has a people filter, check that it includes you.
- [ ] **Your QA profile.** The skills assign tickets and sign reports with the name of the person running them, and hand the `[TC]` items to the TC executor. In **Types & settings → My QA profile**:
  1. **Use my Jira account** fills in your name and accountId (Jira must be connected first).
  2. **Search Jira by name** for the TC executor (currently Paulo Sanchez) and choose them.
  3. **Save profile**. It is saved to `~/.config/avm-qa/profile.json`, the file the skills read.

  Without a profile, the skills use the account you are signed in to Jira with, and the `[TC]` items stay with you (the report says so). The file can also be written by hand:

  ```json
  {
    "tester": { "name": "Your Name", "accountId": "<your Jira accountId>" },
    "tcExecutor": { "name": "Paulo Sanchez", "accountId": "712020:7439f202-d2d1-4c3e-ad76-338d4b912816" }
  }
  ```
- [ ] **Sites & skills.** In **Types & settings → Sites & skills**, check:
  - The QA and STG sites, their Jira statuses and the test run domains. The defaults are the AVM ones.
  - The skill names. If you installed the plugin from the organization, Claude Code shows them with their prefix (for example `/avm-qa-skills:avm-qa-orchestrator`); use exactly the name you see in `/skills`.
- [ ] **Language and appearance** as you prefer. The UI can be switched between English and Spanish.

## 3. Good to know before you start

- **The app does not ask you anything.** Runs execute on their own in `auto` mode: Claude creates bugs, comments and moves tickets **on your behalf**, following each skill's criteria. Review its decisions in the notes of each report.
- **Your data is yours.** It stays only on your Mac (`~/Library/Application Support/QA Dashboard/`). There is no team view.
  - To pass runs to someone else, use **Export backup (JSON)**. Importing **replaces** the data of the person importing.
  - Never share `qa-tests.json`: it contains your Jira API token.
- **To practice without risk:** **Help → Open demo (sample data)** has sample data, and Jira and Claude are simulated there.
- **Updates.** The app does not update itself: when there is a new version, replace the `.app`.

## 4. Final check

- [ ] **Set up this Mac:** in **Types & settings → Set up this Mac**, everything is **Ready** (Claude Code, its sign-in, the QA skills, Claude in Chrome, the QA profile and Jira). What is missing says how to fix it.
- [ ] **Demo:** open **Help → Open demo (sample data)**, launch the smoke on QA and open its report.
- [ ] **Real app:** click **Refresh from Jira** and check that your tickets appear.
- [ ] **Real smoke on QA:** launch it from the Smoke card and check that:
  - **Running** appears with the live activity;
  - it ends in GO, NO-GO or BLOCKED;
  - the report says **Tester: your name**.
- [ ] **Orchestrator on one of your tickets in On QA:** check that:
  - the ticket is assigned to you, not to someone else;
  - the QA comment is signed with your name;
  - the `[TC]` items move to the TC executor when the ticket passes QA.
