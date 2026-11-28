import { existsSync } from 'node:fs';
import os from 'node:os';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { ZodError, z } from 'zod';
import { HttpError } from './errors.js';
import { translateError } from './i18n.js';
import type { Automation, AutomationDetails, AutomationKind, Lang, QueueItem, ReleaseInfo, TeamMember, TeamState, TeamView, UpdateState } from '../shared/types.js';
import { SKILL_KINDS, checkSkill, launchBlocker, probeSetup, profileFacts, readyFacts, setupState, skillOf, type SetupFacts, type SetupProbe, type SkillRename } from './setup.js';
import { fetchJiraMyself, fetchJiraTickets, postJiraComment, searchJiraUsers } from './jira.js';
import { PROFILE_FILE, profileInputSchema, readQaProfile, writeQaProfile } from './profile.js';
import { appVersion, compareVersions, fetchLatestRelease, type LatestRelease } from './updates.js';
import { buildTeamFile, displayPath, prepareTeamFolder, readTeamFolder, removeTeamFile, syncedFolders, teamFileName, writeTeamFile } from './team.js';
import { orList, orchestratorPrompt, regressionPrompt, smokePrompt } from './orchestrator.js';
import {
  MAX_RUN_MS, isClaudeProcess, lastMessage, launchClaude, readActivity, runAssistant, stopPid, translateReport,
  type ClaudeHandle, type ClaudeLauncher, type ReportTranslator,
} from './claudeRunner.js';
import { ASSISTANT_SCHEMA, assistantContext, assistantPrompt, assistantSystem, parseAssistantReply, type AssistantRunner } from './assistant.js';
import { findSite, isTicketKey, readyStatuses, siteForStatus } from '../shared/orchestrator.js';
import { isEnvironmentBlock, isUsageLimit, laneOf, queuePosition, ticketsToValidate } from '../shared/queue.js';
import { claimFor, teamClaims } from '../shared/claims.js';
import { VERDICTS_BY_KIND, automationTitle, reportInstruction, runForAutomation } from './automation.js';
import {
  automationResultSchema, backupSchema, type AutomationResult, jiraConfigSchema, reportBugsEditSchema, reportTranslationSchema, runInputSchema, settingsSchema,
} from './schemas.js';
import type { AppLog } from './log.js';
import type { Store } from './store.js';

export interface AppOptions {
  /** Folder with the built UI; if omitted, only the API is served. */
  clientDir?: string;
  /** Injectable to test the Jira integration without network access. */
  fetchImpl?: typeof fetch;
  /** Injectable to test the QA skills without running Claude Code. */
  launchClaude?: ClaudeLauncher;
  /** Injectable to test report translation without running Claude Code. */
  translateReport?: ReportTranslator;
  /** Injectable to test the assistant without running Claude Code. */
  assistant?: AssistantRunner;
  /** Demo mode: the UI shows it in the header. */
  demo?: boolean;
  /** Whether a saved pid is still a running Claude process; injectable to test runs left by an earlier session. */
  processAlive?: (pid: number) => boolean;
  /** Pause between the end of a run and the start of the next queued one on the same site (default 30 s). */
  laneGapMs?: number;
  /**
   * Checks what this Mac has for runs with Claude. Injectable to test it; when Claude itself is
   * injected (tests, demo) and this is not, the Mac counts as ready.
   */
  probeSetup?: SetupProbe;
  /** The QA profile file (default `~/.config/avm-qa/profile.json`); the demo and the tests use their own. */
  profileFile?: string;
  /**
   * The newest published version. Injectable to test it; when Claude itself is injected (tests, demo)
   * and this is not, there is none, so they never ask GitHub.
   */
  latestRelease?: LatestRelease;
  /** This app's version (default: its package.json). */
  version?: string;
  /** Wait before the first update check (default 10 s, so it never slows down the start). */
  firstUpdateCheckMs?: number;
}

/** Default pause between runs on a site, so Chrome and the site settle before the next one. */
const LANE_GAP_MS = 30_000;

/** How often the Mac's setup is checked again on its own. */
const SETUP_CHECK_MS = 5 * 60_000;
/** A launch trusts a passing setup check this recent; an older one, or a failing one, is done again first. */
const SETUP_FRESH_MS = 60_000;

/** How often the team folder is read, and this app's file written if its data changed. */
const TEAM_SYNC_MS = 60_000;
/** This app's team file is written at least this often, so the team sees it is still active. */
const TEAM_HEARTBEAT_MS = 60 * 60_000;

/** How often GitHub is asked for a newer version. */
const UPDATE_CHECK_MS = 6 * 60 * 60_000;

/** How often runs left by an earlier session are checked. */
const ORPHAN_CHECK_MS = 30_000;

/**
 * Translated report merged onto the original: only the texts are taken from the translation
 * (by position); statuses, minutes, keys and links always come from the original.
 */
function mergeTranslation(original: AutomationDetails, translated: ReturnType<typeof reportTranslationSchema.parse>['details']): AutomationDetails {
  if (!translated) return original;
  return {
    ...original,
    build: translated.build || original.build,
    notes: translated.notes || original.notes,
    modules: original.modules.map((m, i) => {
      const t = translated.modules[i];
      return {
        ...m,
        name: t?.name || m.name,
        notes: t?.notes || m.notes,
        steps: m.steps.map((step, j) => ({ ...step, name: t?.steps[j]?.name || step.name, notes: t?.steps[j]?.notes || step.notes })),
      };
    }),
    bugs: original.bugs.map((b, i) => ({ ...b, title: translated.bugs[i]?.title || b.title, module: translated.bugs[i]?.module || b.module })),
  };
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

/**
 * The app must only answer this machine. Checks the Host (prevents DNS
 * rebinding) and the Origin (prevents another site open in the browser from calling the API).
 */
const localOnly = (lang: () => Lang): RequestHandler => (req, res, next) => {
  const hostHeader = req.headers.host ?? '';
  const host = hostHeader.split(':')[0] ?? '';
  let originOk = true;
  if (req.headers.origin) {
    // Only the app's own page: another local tool or dev server (any other port) is a different origin.
    // Behind the Vite dev proxy the Host is forwarded as is, so the dev page is still same-origin.
    try {
      originOk = new URL(req.headers.origin).host === hostHeader;
    } catch {
      originOk = false;
    }
  }
  if (!LOCAL_HOSTS.has(host) || !originOk) {
    res.status(403).json({ error: translateError('Local access only', lang()) });
    return;
  }
  next();
};

/**
 * Changes must be JSON requests: a browser cannot send that content type to another origin without
 * a CORS preflight (which this server never approves), so a form or `no-cors` fetch from any page is refused.
 */
const jsonWrites = (lang: () => Lang): RequestHandler => (req, res, next) => {
  // The header, not req.is(): a DELETE has no body but must still declare JSON.
  const type = (req.headers['content-type'] ?? '').toLowerCase();
  if (req.method === 'GET' || req.method === 'HEAD' || type.startsWith('application/json')) {
    next();
    return;
  }
  res.status(415).json({ error: translateError('Changes must be sent as JSON', lang()) });
};

/** No page may frame the app (clickjacking), and it only loads its own scripts and data. */
const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  );
  next();
};

const errorHandler = (lang: () => Lang, log: AppLog): ErrorRequestHandler => (err, req, res, _next) => {
  const send = (status: number, error: string): void => {
    res.status(status).json({ error: translateError(error, lang()) });
  };
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    const field = issue?.path.join('.');
    send(400, `Invalid data${field ? ` (${field})` : ''}: ${issue?.message ?? ''}`);
    return;
  }
  if (err instanceof HttpError) {
    // Jira or Claude failing is worth tracing; a refused request (4xx) is the user's to read in the app.
    if (err.status >= 500) log.warn('request.failed', { route: `${req.method} ${req.path}`, status: err.status, error: err.message });
    send(err.status, err.message);
    return;
  }
  if (err instanceof SyntaxError) {
    send(400, 'Invalid JSON');
    return;
  }
  log.error('request.error', err, { route: `${req.method} ${req.path}` });
  send(500, 'Internal app error');
};

export function createApp(store: Store, options: AppOptions = {}): Express {
  const lang = (): Lang => store.getState().settings.language;
  const { log } = store;
  const app = express();
  app.disable('x-powered-by');
  app.use(localOnly(lang));
  app.use(securityHeaders);

  const api = express.Router();
  /**
   * Port the app answers on: Claude's report URL needs it. Queued runs start without a request, so
   * it is taken from the requests; the first one also starts a queue left by an earlier session.
   */
  let port = 0;
  api.use((req, _res, next) => {
    const known = port !== 0;
    port = req.socket.localPort ?? port;
    if (!known && port !== 0) setImmediate(() => pump());
    next();
  });
  api.use(jsonWrites(lang));
  api.use(express.json({ limit: '5mb' }));
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // ── Setup: what this Mac has for runs with Claude ─────────────────────────────────────────────
  const profileFile = options.profileFile ?? PROFILE_FILE;
  const probe: SetupProbe =
    options.probeSetup ??
    (options.launchClaude
      ? async () => ({ ...readyFacts(Object.values(store.getState().settings.qa.skills).map(skillOf)), profile: profileFacts(profileFile) })
      : () => probeSetup(profileFile));
  let setupFacts: SetupFacts | null = null;
  let setupCheckedAt = 0;
  let setupChecking: Promise<SetupFacts> | null = null;
  const renamedSkills: Partial<Record<AutomationKind, SkillRename>> = {};
  let lastSetupLog = '';

  /** Checks the Mac again (one check at a time) and switches a skill name Claude Code has under another prefix. */
  const checkSetup = (): Promise<SetupFacts> => {
    setupChecking ??= probe()
      .then((facts) => {
        const { settings } = store.getState();
        let { skills } = settings.qa;
        for (const kind of SKILL_KINDS) {
          const { suggestion } = checkSkill(skills[kind], facts.skills);
          if (!suggestion) continue;
          renamedSkills[kind] = { from: skills[kind], to: suggestion };
          log.info('setup.skill-renamed', { kind, from: skills[kind], to: suggestion });
          skills = { ...skills, [kind]: suggestion };
        }
        if (skills !== settings.qa.skills) store.saveSettings({ ...settings, qa: { ...settings.qa, skills } });
        setupFacts = facts;
        setupCheckedAt = Date.now();
        // Logged when the answer changes, not every few minutes.
        const state = currentSetup()!;
        const summary = state.checks.filter((c) => c.status !== 'ok').map((c) => `${c.id}=${c.status}`).join(' ') || 'all ok';
        if (summary !== lastSetupLog) log.info('setup.check', { ready: state.ready, claude: facts.claude?.version, issues: summary });
        lastSetupLog = summary;
        return facts;
      })
      .finally(() => {
        setupChecking = null;
      });
    return setupChecking;
  };
  /**
   * A check that starts now: one already running may have read the Mac before a change the caller
   * knows about (a profile just saved, a fix the tester made), so it runs after that one ends.
   */
  const recheckSetup = async (): Promise<SetupFacts> => {
    if (setupChecking) await setupChecking.catch(() => undefined);
    return checkSetup();
  };
  const currentSetup = () => {
    if (!setupFacts) return null;
    const { settings, jira } = store.getState();
    return setupState(setupFacts, settings.qa, jira, renamedSkills, setupCheckedAt);
  };
  /**
   * Refuses a run this Mac cannot do. A recent passing check answers at once (no await, so a launch
   * stays synchronous up to Claude); a failing or stale one is done again first, so a fix counts right away.
   */
  const assertCanLaunch = (kind: AutomationKind): Promise<void> | undefined => {
    const fresh = Date.now() - setupCheckedAt <= SETUP_FRESH_MS;
    if (setupFacts && fresh && !launchBlocker(setupFacts, store.getState().settings.qa, kind)) return undefined;
    return checkSetup().then((facts) => {
      const why = launchBlocker(facts, store.getState().settings.qa, kind);
      if (why) throw new HttpError(503, why);
    });
  };
  void checkSetup().catch((err: unknown) => log.error('setup.check-failed', err));
  setInterval(() => void checkSetup().catch((err: unknown) => log.error('setup.check-failed', err)), SETUP_CHECK_MS).unref();

  // ── Updates: a newer version published on GitHub ──────────────────────────────────────────────
  const latestRelease: LatestRelease = options.latestRelease ?? (options.launchClaude ? async () => null : fetchLatestRelease());
  const version = options.version ?? appVersion();
  let release: ReleaseInfo | null = null;
  let updateCheckedAt: number | null = null;
  let updateError: string | null = null;
  let announced = '';
  let updateChecking: Promise<void> | null = null;
  const checkUpdates = (): Promise<void> => {
    updateChecking ??= latestRelease()
      .then((found) => {
        release = found;
        updateError = null;
        if (found && compareVersions(found.version, version) > 0 && announced !== found.version) {
          announced = found.version;
          log.info('update.available', { current: version, latest: found.version });
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message !== updateError) log.warn('update.check-failed', { error: message });
        updateError = message;
      })
      .finally(() => {
        updateCheckedAt = Date.now();
        updateChecking = null;
      });
    return updateChecking;
  };
  const currentUpdate = (): UpdateState | null =>
    options.demo
      ? null
      : {
          current: version,
          arch: process.arch,
          latest: release,
          available: release !== null && compareVersions(release.version, version) > 0,
          checkedAt: updateCheckedAt,
          error: updateError,
        };
  setTimeout(() => void checkUpdates(), options.firstUpdateCheckMs ?? 10_000).unref();
  setInterval(() => void checkUpdates(), UPDATE_CHECK_MS).unref();

  // ── Team folder: this app writes its own file and reads everyone else's ─────────────────────────
  let teamOwnFile = '';
  let teamWrittenAt: number | null = null;
  let teamReadAt: number | null = null;
  let teamError: string | null = null;
  let teamWritten = '';
  let teammates: TeamMember[] = [];
  let teamProblems: { file: string; error: string }[] = [];
  /** Writes this app's file if its data or name changed (or an hour went by), then reads the folder. */
  const syncTeam = (force = false): void => {
    const { folder, name, memberId } = store.getTeamConfig();
    if (!folder) return;
    try {
      if (!existsSync(folder)) throw new Error(`The team folder ${displayPath(folder)} is not there (is the sync app running?)`);
      const stamp = `${name}|${store.revision}`;
      if (force || stamp !== teamWritten || Date.now() - (teamWrittenAt ?? 0) > TEAM_HEARTBEAT_MS) {
        const { settings, runs, automations, queue } = store.getState();
        teamOwnFile = writeTeamFile(folder, buildTeamFile({ id: memberId, name }, version, settings.types, runs, automations, Date.now(), queue.items));
        teamWrittenAt = Date.now();
        teamWritten = stamp;
      }
      ({ members: teammates, problems: teamProblems } = readTeamFolder(folder, memberId));
      teamReadAt = Date.now();
      if (teamError) log.info('team.ok', { folder: displayPath(folder) });
      teamError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== teamError) log.warn('team.sync-failed', { folder: displayPath(folder), error: message });
      teamError = message;
    }
  };
  const teamState = (): TeamState => {
    const { folder, name } = store.getTeamConfig();
    return {
      folder: folder ? displayPath(folder) : '', name, ownFile: teamOwnFile, writtenAt: teamWrittenAt, readAt: teamReadAt,
      error: folder && teamError ? translateError(teamError, lang()) : null,
      claims: folder ? teamClaims(teammates) : [],
    };
  };
  const teamView = (): TeamView => {
    const { folder, name, memberId } = store.getTeamConfig();
    if (!folder) return { ...teamState(), members: [], problems: [] };
    const { settings, runs, automations, queue } = store.getState();
    const me: TeamMember = {
      id: memberId, name, app: version, updatedAt: teamWrittenAt ?? Date.now(), file: teamOwnFile || teamFileName({ id: memberId, name }), me: true,
      types: settings.types, runs, automations, queue: queue.items.map(({ kind, target, site, addedAt }) => ({ kind, target, site, addedAt })),
    };
    return { ...teamState(), members: [me, ...teammates], problems: teamProblems.map((p) => ({ ...p, error: translateError(p.error, lang()) })) };
  };
  if (!options.demo || store.getTeamConfig().folder) {
    setTimeout(() => syncTeam(), 3_000).unref();
    setInterval(() => syncTeam(), TEAM_SYNC_MS).unref();
  }

  api.get('/team', (_req, res) => {
    syncTeam();
    res.json(teamView());
  });

  api.get('/team/folders', (_req, res) => {
    res.json({ suggestions: syncedFolders() });
  });

  api.put('/team', (req, res) => {
    const input = z.object({ folder: z.string().trim().min(1).max(500), name: z.string().trim().min(1, 'Your name in the team is needed').max(120) }).parse(req.body);
    let folder: string;
    try {
      folder = prepareTeamFolder(input.folder);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    const before = store.getTeamConfig();
    // Moving to another folder: this app's file leaves the old one.
    if (before.folder && before.folder !== folder) removeTeamFile(before.folder, before.memberId);
    store.saveTeamConfig({ folder, name: input.name });
    log.info('team.join', { folder: displayPath(folder) });
    syncTeam(true);
    res.json(teamView());
  });

  /** Leaves the team: this app's file is taken out of the folder and nothing more is written. */
  api.delete('/team', (_req, res) => {
    const { folder, memberId } = store.getTeamConfig();
    if (folder) {
      try {
        removeTeamFile(folder, memberId);
      } catch {
        // The folder may be gone already.
      }
      log.info('team.leave', { folder: displayPath(folder) });
    }
    store.saveTeamConfig({ folder: '', name: store.getTeamConfig().name });
    teammates = [];
    teamProblems = [];
    teamOwnFile = '';
    teamWrittenAt = null;
    teamReadAt = null;
    teamError = null;
    res.json(teamView());
  });

  api.post('/updates/check', async (_req, res) => {
    await checkUpdates();
    res.json(fullState());
  });

  api.get('/state', (_req, res) => {
    res.json(fullState());
  });

  api.post('/setup/check', async (_req, res) => {
    await recheckSetup();
    res.json(fullState());
  });

  /** A test run always points to a test type that exists in the settings. */
  const parseRun = (body: unknown) => {
    const input = runInputSchema.parse(body);
    if (!store.getState().settings.types.some((t) => t.id === input.typeId)) throw new HttpError(400, 'That test type does not exist');
    return input;
  };

  api.post('/runs', (req, res) => {
    res.status(201).json(store.createRun(parseRun(req.body)));
  });

  api.put('/runs/:id', (req, res) => {
    const run = store.updateRun(String(req.params.id), parseRun(req.body));
    if (!run) throw new HttpError(404, 'That test run no longer exists');
    res.json(run);
  });

  api.delete('/runs/:id', (req, res) => {
    const run = store.getState().runs.find((r) => r.id === String(req.params.id));
    if (!store.deleteRun(String(req.params.id))) throw new HttpError(404, 'That test run no longer exists');
    // A run that disappeared can be found here, with the copy to restore it from.
    log.info('record.delete', { id: run?.id, date: run?.date, title: run?.title, ticket: run?.ticket });
    res.status(204).end();
  });

  api.put('/settings', (req, res) => {
    const before = lang();
    const next = settingsSchema.parse(req.body);
    // As in the UI: a type with test runs cannot be removed (they would be left without a type).
    const kept = new Set(next.types.map((t) => t.id));
    const orphan = store.getState().runs.find((r) => !kept.has(r.typeId));
    if (orphan) {
      const name = store.getState().settings.types.find((t) => t.id === orphan.typeId)?.name ?? orphan.typeId;
      throw new HttpError(409, `The type “${name}” has runs and cannot be removed`);
    }
    const settings = store.saveSettings(next);
    if (settings.language !== before) translateAll(settings.language);
    res.json(settings);
  });

  const translate = options.translateReport ?? translateReport;
  /** Queued or in-progress translations ("id:lang"); failed ones are not retried automatically. */
  const translating = new Map<string, Promise<Automation | null>>();
  const failedTranslations = new Set<string>();
  const needsTranslation = (a: Automation, to: Lang): boolean =>
    a.finishedAt !== null && a.lang !== to && !a.translations[to] && (a.summary !== '' || a.details !== null);

  /** Translates a run's summary and report with Claude and saves the translation. */
  const translateOne = (id: string, to: Lang): Promise<Automation | null> => {
    const key = `${id}:${to}`;
    const current = translating.get(key);
    if (current) return current;
    const automation = store.getAutomation(id);
    if (!automation || !needsTranslation(automation, to)) return Promise.resolve(automation);
    // The Jira comment is not translated: it goes to the ticket exactly as the skill wrote it.
    // Inside a promise: a translator that throws at once (no claude on this Mac) becomes a failed translation, not a crash.
    const job = Promise.resolve()
      .then(() => translate({ summary: automation.summary, details: automation.details ? { ...automation.details, jiraComment: null } : null }, to))
      .then((raw) => {
        const result = reportTranslationSchema.parse(raw);
        const latest = store.getAutomation(id);
        if (!latest?.details && !latest?.summary) return latest;
        return store.saveTranslation(id, to, {
          summary: result.summary || latest.summary,
          details: latest.details ? mergeTranslation(latest.details, result.details) : null,
        });
      })
      .catch((err: unknown) => {
        failedTranslations.add(key);
        log.warn('report.translate-failed', { run: id, to, error: err instanceof Error ? err.message : String(err) });
        throw err instanceof HttpError ? err : new HttpError(502, `Could not translate the report: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => translating.delete(key));
    translating.set(key, job);
    return job;
  };

  /** When the language changes, runs Claude wrote in the other language are translated one at a time. */
  let queue: Promise<unknown> = Promise.resolve();
  const translateAll = (to: Lang): void => {
    for (const a of store.getState().automations) {
      const key = `${a.id}:${to}`;
      if (!needsTranslation(a, to) || failedTranslations.has(key) || translating.has(key)) continue;
      let release: (value: Automation | null) => void = () => undefined;
      // Reserve the queue slot so the state counts pending translations.
      translating.set(key, new Promise((resolve) => (release = resolve)));
      queue = queue
        .then(async () => {
          let result: Automation | null = null;
          try {
            translating.delete(key);
            result = lang() === to ? await translateOne(a.id, to).catch(() => null) : null;
          } finally {
            release(result);
          }
        })
        // One failed job never blocks the ones queued after it.
        .catch(() => undefined);
    }
  };
  translateAll(lang());

  const fullState = () => ({ ...store.getState(), translating: translating.size, demo: options.demo === true, setup: currentSetup(), update: currentUpdate(), team: teamState() });

  /** Nothing may be running or queued while the data is replaced: their results would land in the other data. */
  const assertIdle = (): void => {
    const { automations, queue } = store.getState();
    if (automations.some((a) => a.finishedAt === null) || queue.items.length > 0) {
      throw new HttpError(409, 'Wait until no run is in progress or queued (or stop them) before replacing the data');
    }
  };

  const replaceData = (backup: ReturnType<typeof backupSchema.parse>, reason: 'before-import' | 'before-restore') => {
    const before = lang();
    const saved = store.importBackup(backup, reason);
    if (lang() !== before) translateAll(lang());
    return { saved, runs: backup.runs.length, reports: backup.automations?.length };
  };

  api.post('/import', (req, res) => {
    const backup = backupSchema.parse(req.body);
    assertIdle();
    const { saved, runs, reports } = replaceData(backup, 'before-import');
    log.info('data.import', { runs, reports, previous: saved });
    res.json(fullState());
  });

  /** A folder as the user reads it: "~/Library/…" instead of the full home path. */
  const shown = (dir: string): string => {
    const home = os.homedir();
    return dir === home || dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
  };

  /** Automatic copies of the data file (one a day, and before every import or restore). */
  api.get('/backups', (_req, res) => {
    res.json({ dir: shown(store.backupsDir), items: store.listBackups() });
  });

  /** A copy of the data as it is now. */
  api.post('/backups', (_req, res) => {
    const name = store.backupNow('manual');
    if (!name) throw new HttpError(409, 'There is no data to back up yet');
    res.json({ dir: shown(store.backupsDir), items: store.listBackups(), created: name });
  });

  /** Brings back the runs, reports and settings of a backup (the Jira connection stays as it is). */
  api.post('/backups/:name/restore', (req, res) => {
    const name = String(req.params.name);
    let saved;
    try {
      saved = store.readBackup(name);
    } catch {
      throw new HttpError(422, 'That backup cannot be read');
    }
    if (!saved) throw new HttpError(404, 'That backup does not exist');
    const backup = backupSchema.safeParse({ ...saved.settings, runs: saved.runs, automations: saved.automations });
    if (!backup.success) throw new HttpError(422, 'That backup cannot be read');
    assertIdle();
    const { saved: previous, runs, reports } = replaceData(backup.data, 'before-restore');
    log.info('data.restore', { from: name, runs, reports, previous });
    res.json(fullState());
  });

  /** The end of the app's log, to copy it when something went wrong. */
  api.get('/log', (_req, res) => {
    res.json({ file: shown(log.file), lines: log.tail(300) });
  });

  // ── QA profile: who runs the skills, and who runs the TCs ──────────────────────────────────────
  api.get('/profile', (_req, res) => {
    res.json(readQaProfile(profileFile));
  });

  api.put('/profile', async (req, res) => {
    const profile = writeQaProfile(profileInputSchema.parse(req.body), profileFile);
    log.info('profile.saved', { file: profile.file, tcExecutor: profile.tcExecutor !== null });
    await recheckSetup();
    res.json({ profile, setup: currentSetup() });
  });

  api.get('/jira/myself', async (_req, res) => {
    res.json(await fetchJiraMyself(store.getJiraCredentials(), options.fetchImpl));
  });

  api.get('/jira/users', async (req, res) => {
    const query = z.string().trim().min(2).max(100).parse(req.query.query);
    res.json(await searchJiraUsers(store.getJiraCredentials(), query, options.fetchImpl));
  });

  api.put('/jira/config', (req, res) => {
    store.saveJiraConfig(jiraConfigSchema.parse(req.body));
    res.json(store.getJiraState());
  });

  api.post('/jira/refresh', async (_req, res) => {
    try {
      const tickets = await fetchJiraTickets(store.getJiraCredentials(), options.fetchImpl);
      const before = store.getJiraState();
      store.saveJiraTickets(tickets);
      // Only when something changed: the app refreshes every few minutes.
      if (before.connection !== 'connected' || before.tickets.length !== tickets.length) log.info('jira.refresh', { tickets: tickets.length });
    } catch (err) {
      // Only Jira failures change the connection state; "not configured yet" is not a failed connection.
      if (err instanceof HttpError && err.status === 502) {
        store.saveJiraError(translateError(err.message, lang()));
        log.warn('jira.refresh-failed', { error: err.message });
      }
      throw err;
    }
    res.json(store.getJiraState());
  });

  const launch = options.launchClaude ?? launchClaude;
  /** Running processes launched by this server. */
  const running = new Map<string, ClaudeHandle>();
  /** Runs whose process is being started (they have no pid yet). */
  const launching = new Set<string>();

  /** Saves a run's result and completes its test run. */
  const complete = (id: string, result: AutomationResult) => {
    const automation = store.getAutomation(id);
    if (!automation) throw new HttpError(404, 'That run does not exist or was dismissed');
    if (automation.finishedAt !== null) throw new HttpError(409, 'That run already has a result');
    const valid = VERDICTS_BY_KIND[automation.kind];
    if (!valid.includes(result.verdict)) {
      throw new HttpError(400, `Verdict ${result.verdict} is not valid for this run: use ${valid.join(', ')}`);
    }
    const { verdict, summary, link } = result;
    // In test mode nothing goes to Jira: a comment Claude prepared anyway is not offered for posting.
    const details = automation.dryRun && result.details ? { ...result.details, jiraComment: null } : result.details;
    const runInput = runInputSchema.parse(runForAutomation(automation, store.getState().settings, result));
    const finished = store.finishAutomation(id, { verdict, summary, link, details }, runInput);
    if (finished) {
      log[verdict === 'FAILED' || verdict === 'BLOCKED' || verdict === 'NO-GO' ? 'warn' : 'info']('claude.finish', {
        id, kind: automation.kind, target: automation.target, site: automation.site, verdict,
        minutes: Math.round((Date.now() - automation.startedAt) / 60_000), summary: summary.split('\n')[0]?.slice(0, 200),
      });
      afterFinish(finished);
    }
    // Its lane is free: the next queued run starts after the pause.
    pump();
    return finished;
  };

  /** Closes as BLOCKED a run whose process ended or was stopped without reporting. */
  const closeUnreported = (id: string, summary: string): void => {
    const automation = store.getAutomation(id);
    if (!automation || automation.finishedAt !== null) return;
    complete(id, automationResultSchema.parse({ verdict: 'BLOCKED', summary: summary.slice(0, 4900) }));
  };

  /** What a launch needs: the run to record (with its lane) and the prompt for Claude. */
  interface LaunchSpec {
    input: Parameters<Store['startAutomation']>[0];
    prompt: (extra: string) => string;
  }

  /** The orchestrator on a loaded ticket, on the site its Jira status maps to (On QA → QA, On Staging → STG). */
  const orchestratorSpec = (key: string, fullCoverage = false): LaunchSpec => {
    if (!isTicketKey(key)) throw new HttpError(400, `Invalid ticket: ${key}`);
    const ticket = store.getJiraState().tickets.find((t) => t.key === key);
    if (!ticket) throw new HttpError(404, `${key} is not among the loaded Jira tickets`);
    const { qa } = store.getState().settings;
    const site = siteForStatus(ticket.status, qa);
    if (!site) {
      throw new HttpError(409, `${key} is in "${ticket.status}"; the orchestrator is for tickets in ${orList(readyStatuses(qa))}`);
    }
    const title = automationTitle('orchestrator', key, lang(), ticket.summary);
    return {
      input: { kind: 'orchestrator', target: key, env: site.env, title, site: site.id, ticketType: ticket.type, fullCoverage },
      prompt: (extra) => orchestratorPrompt(key, qa, extra, fullCoverage),
    };
  };

  const smokeSpec = (siteId: unknown): LaunchSpec => {
    const { qa } = store.getState().settings;
    const site = findSite(siteId, qa);
    if (!site) throw new HttpError(400, `That site does not exist: choose ${orList(qa.sites.map((s) => s.name))}`);
    const title = automationTitle('smoke', site.name, lang());
    return { input: { kind: 'smoke', target: site.name, env: site.env, title, site: site.id }, prompt: (extra) => smokePrompt(site.id, qa, extra) };
  };

  const regressionSpec = (run: string, dryRun: boolean): LaunchSpec => {
    const { qa } = store.getState().settings;
    const env = findSite(qa.regressionSiteId, qa)?.env ?? '';
    const title = automationTitle('regression', run, lang(), '', dryRun);
    return {
      input: { kind: 'regression', target: run, env, title, dryRun, site: qa.regressionSiteId },
      prompt: (extra) => regressionPrompt(run, qa, extra, dryRun),
    };
  };

  /** The spec of a queued run, read again when its turn comes (the ticket or the settings may have changed). */
  const specFor = (item: QueueItem): LaunchSpec =>
    item.kind === 'orchestrator' ? orchestratorSpec(item.target, item.fullCoverage) : item.kind === 'smoke' ? smokeSpec(item.site) : regressionSpec(item.target, item.dryRun);

  /** Launches Claude Code in the background and leaves the run "in progress" until it reports the result. */
  const launchAutomation = async ({ input, prompt }: LaunchSpec) => {
    prompt(''); // Validate before recording anything.
    const check = assertCanLaunch(input.kind);
    if (check) await check;
    // A double click does not launch two Claude processes on the same target; another site or ticket can run at the same time.
    const busy = store.getState().automations.find((a) => a.finishedAt === null && a.kind === input.kind && a.target === input.target);
    if (busy) throw new HttpError(409, `There is already a run in progress for ${input.kind === 'orchestrator' ? input.target : `${input.kind} ${input.target}`.trim()}`);
    const settings = store.getState().settings;
    const automation = store.startAutomation(input, (a) => runInputSchema.parse(runForAutomation(a, settings)));
    const reportKey = store.newReportKey(automation.id);
    const en = settings.language === 'en';
    launching.add(automation.id);
    try {
      const handle = await launch({
        id: automation.id,
        prompt: prompt(reportInstruction(input.kind, port, automation.id, settings.language, reportKey)),
        onExit: ({ code, lastMessage }) => {
          running.delete(automation.id);
          // Claude reports with a POST before exiting; if it did not, the run must not stay "in progress" forever.
          const why = en
            ? `Claude finished without reporting a result (exit code ${code ?? 'none'}).`
            : `Claude terminó sin reportar el resultado (código de salida ${code ?? 'ninguno'}).`;
          closeUnreported(automation.id, [why, lastMessage].filter(Boolean).join('\n'));
        },
      });
      running.set(automation.id, handle);
      store.setAutomationProcess(automation.id, handle.pid, handle.logFile);
      log.info('claude.start', {
        id: automation.id, kind: input.kind, target: input.target, site: input.site, dryRun: input.dryRun || undefined, fullCoverage: input.fullCoverage || undefined,
        queued: input.queued ? `batch ${input.queued.batch}${input.queued.retries ? ' retry' : ''}` : undefined, pid: handle.pid, claudeLog: handle.logFile,
      });
    } catch (err) {
      store.deleteAutomation(automation.id);
      log.error('claude.launch-failed', err, { kind: input.kind, target: input.target, site: input.site });
      throw err;
    } finally {
      launching.delete(automation.id);
    }
    return store.getAutomation(automation.id);
  };

  // ── Queue: one run at a time per site ───────────────────────────────────────────────────────────
  const laneGapMs = options.laneGapMs ?? LANE_GAP_MS;
  /** Lanes whose next queued run is being started. */
  const starting = new Set<string>();
  const laneBusy = (site: string): boolean => {
    const { automations, settings } = store.getState();
    return starting.has(site) || automations.some((a) => a.finishedAt === null && laneOf(a, settings.qa) === site);
  };
  const runLabel = (kind: Automation['kind'], target: string): string => (kind === 'orchestrator' ? target : `${kind} ${target}`.trim());

  /**
   * A launch from a button or the assistant: it starts now if its site's lane is free, or waits in
   * the queue behind the runs already there (HTTP 202 with its position).
   */
  const requestLaunch = async (spec: LaunchSpec): Promise<Automation | null | { queued: QueueItem; position: number }> => {
    spec.prompt(''); // Validate before recording anything.
    const { kind, target, site } = spec.input;
    // Refused before queueing too: a run that cannot start should not wait in line.
    const check = assertCanLaunch(kind);
    if (check) await check;
    const { automations, queue } = store.getState();
    // A double click does not launch or queue the same run twice.
    if (automations.some((a) => a.finishedAt === null && a.kind === kind && a.target === target)) {
      throw new HttpError(409, `There is already a run in progress for ${runLabel(kind, target)}`);
    }
    if (queue.items.some((q) => q.kind === kind && q.target === target)) throw new HttpError(409, `${runLabel(kind, target)} is already queued`);
    if (laneBusy(site) || queue.items.some((q) => q.site === site)) {
      const [queued] = store.enqueue([{ kind, target, site, dryRun: spec.input.dryRun ?? false, fullCoverage: spec.input.fullCoverage ?? false }]);
      const position = queuePosition(store.getState().queue.items, queued!);
      log.info('queue.add', { kind, target, site, position });
      return { queued: queued!, position };
    }
    return launchAutomation(spec);
  };

  /**
   * A queued ticket a teammate is validating now, or validated on this site after it was queued, is
   * not run again here (the team folder is read every minute, so two Macs can still overlap briefly).
   */
  const teammateBlocker = (item: QueueItem): void => {
    if (!store.getTeamConfig().folder) return;
    syncTeam();
    const site = findSite(item.site, store.getState().settings.qa) ?? null;
    const claim = claimFor(teamClaims(teammates), item.target, site);
    if (claim?.state === 'running') throw new HttpError(409, `${claim.by} is already validating ${item.target}`);
    if (claim?.state === 'validated' && claim.at > item.addedAt) {
      throw new HttpError(409, `${claim.by} validated ${item.target} after it was queued: ${claim.verdict}`);
    }
  };

  /** Starts a queued run. If it no longer applies it is dropped saying why; if Claude cannot start, its lane stops. */
  const startQueued = async (item: QueueItem): Promise<void> => {
    starting.add(item.site);
    store.dequeue(item.id);
    const message = (err: unknown): string => translateError(err instanceof Error ? err.message : String(err), lang());
    try {
      let spec: LaunchSpec;
      try {
        spec = specFor(item);
        if (spec.input.site !== item.site) {
          throw new HttpError(409, `${item.target} moved to another site's status; launch it again from its card`);
        }
        if (item.kind === 'orchestrator') teammateBlocker(item);
      } catch (err) {
        store.recordSkip(item, message(err));
        log.warn('queue.skip', { kind: item.kind, target: item.target, site: item.site, reason: message(err) });
        return;
      }
      try {
        await launchAutomation({ ...spec, input: { ...spec.input, queued: { batch: item.batch, retries: item.retries } } });
      } catch (err) {
        if (err instanceof HttpError && err.status < 500) {
          store.recordSkip(item, message(err));
          log.warn('queue.skip', { kind: item.kind, target: item.target, site: item.site, reason: message(err) });
        } else {
          // Claude Code could not start: the run waits at the head of its lane until the user resumes it.
          store.requeueFirst(item);
          store.setLanePaused(item.site, message(err));
          log.warn('queue.pause', { site: item.site, reason: message(err) });
        }
      }
    } finally {
      starting.delete(item.site);
      pump();
    }
  };

  /** When each lane was last resumed: earlier BLOCKED runs no longer count towards pausing it. */
  const resumedAt = new Map<string, number>();
  /** Two runs in a row BLOCKED by the environment on a site pause its queue. */
  const PAUSE_AFTER_BLOCKS = 2;

  /**
   * What a finished run means for the queue: a ticket BLOCKED by the environment is retried once at
   * the end of its site; a used-up Claude plan pauses every site with runs waiting; two runs in a row
   * BLOCKED by the environment pause their site; and when a whole batch is done, its summary is kept.
   */
  const afterFinish = (a: Automation): void => {
    const { automations, queue, settings } = store.getState();
    const en = settings.language === 'en';
    const site = laneOf(a, settings.qa);
    if (a.queued && a.kind === 'orchestrator' && a.queued.retries < 1 && isEnvironmentBlock(a) && !isUsageLimit(a)) {
      store.enqueue([{ kind: a.kind, target: a.target, site, dryRun: a.dryRun, fullCoverage: a.fullCoverage, batch: a.queued.batch, retries: a.queued.retries + 1 }]);
      log.info('queue.retry', { target: a.target, site, reason: 'BLOCKED by the environment' });
    }
    const waiting = new Set(store.getState().queue.items.map((q) => q.site));
    if (isUsageLimit(a)) {
      const why = en ? `Claude's usage limit was reached: ${a.summary}` : `Se alcanzó el límite de uso de Claude: ${a.summary}`;
      for (const lane of waiting) {
        if (queue.paused[lane] !== undefined) continue;
        store.setLanePaused(lane, why.slice(0, 500));
        log.warn('queue.pause', { site: lane, reason: 'Claude usage limit' });
      }
    } else if (waiting.has(site) && queue.paused[site] === undefined) {
      const since = resumedAt.get(site) ?? 0;
      const recent = automations
        .filter((x) => x.finishedAt !== null && x.finishedAt > since && laneOf(x, settings.qa) === site)
        .sort((x, y) => y.finishedAt! - x.finishedAt!)
        .slice(0, PAUSE_AFTER_BLOCKS);
      if (recent.length === PAUSE_AFTER_BLOCKS && recent.every((x) => isEnvironmentBlock(x))) {
        const why = en
          ? `${PAUSE_AFTER_BLOCKS} runs in a row were BLOCKED by the environment (site, login or browser). Last one: ${a.summary}`
          : `${PAUSE_AFTER_BLOCKS} ejecuciones seguidas quedaron BLOCKED por el ambiente (sitio, login o navegador). La última: ${a.summary}`;
        store.setLanePaused(site, why.slice(0, 500));
        log.warn('queue.pause', { site, reason: `${PAUSE_AFTER_BLOCKS} runs in a row BLOCKED by the environment` });
      }
    }
    // The batch is done when none of its runs is waiting or running.
    if (a.queued) {
      const { batch } = a.queued;
      const state = store.getState();
      const inBatch = state.automations.filter((x) => x.queued?.batch === batch);
      if (!state.queue.items.some((q) => q.batch === batch) && inBatch.every((x) => x.finishedAt !== null)) {
        // The last attempt of each run decides (a retried ticket counts once).
        const last = new Map<string, Automation>();
        for (const x of [...inBatch].sort((p, q) => p.startedAt - q.startedAt)) last.set(`${x.kind}:${x.target}`, x);
        const verdicts: Partial<Record<NonNullable<Automation['verdict']>, number>> = {};
        for (const x of last.values()) if (x.verdict) verdicts[x.verdict] = (verdicts[x.verdict] ?? 0) + 1;
        const from = Math.min(...inBatch.map((x) => x.startedAt));
        const to = Math.max(...inBatch.map((x) => x.finishedAt!));
        const minutes = Math.max(1, Math.round((to - from) / 60_000));
        store.recordBatchDone({ batch, at: Date.now(), verdicts, minutes });
        log.info('queue.batch-done', { batch, minutes, ...verdicts });
      }
    }
  };

  let gapTimer: NodeJS.Timeout | null = null;
  /** Starts the next queued run on every free lane, once the pause after its last run is over. */
  const pump = (): void => {
    if (port === 0) return; // The report URL needs the port: the first request brings it.
    const { automations, queue, settings } = store.getState();
    let soonest = Infinity;
    for (const site of new Set(queue.items.map((q) => q.site))) {
      if (queue.paused[site] !== undefined || laneBusy(site)) continue;
      const lastEnd = Math.max(0, ...automations.filter((a) => a.finishedAt !== null && laneOf(a, settings.qa) === site).map((a) => a.finishedAt!));
      const wait = lastEnd + laneGapMs - Date.now();
      if (wait > 0) soonest = Math.min(soonest, wait);
      else void startQueued(queue.items.find((q) => q.site === site)!);
    }
    if (gapTimer) clearTimeout(gapTimer);
    gapTimer = null;
    if (soonest !== Infinity) {
      gapTimer = setTimeout(() => {
        gapTimer = null;
        pump();
      }, soonest);
      gapTimer.unref();
    }
  };

  /** Stops a run's process, whether this server or a previous one launched it. */
  const stopProcess = (id: string): void => {
    const handle = running.get(id);
    if (handle) handle.stop();
    else {
      // A pid saved by an earlier session is only signaled if it is still that Claude process (pids get reused).
      const pid = store.getAutomation(id)?.pid;
      if (pid && processAlive(pid)) stopPid(pid);
    }
    running.delete(id);
  };

  /**
   * Runs this server did not launch (the app was closed or crashed while they ran) are watched here:
   * one whose Claude process is gone is closed as BLOCKED, and one past the time limit is stopped.
   * Without this they stayed "in progress" forever and blocked new runs on the same target.
   */
  const processAlive = options.processAlive ?? isClaudeProcess;
  const checkOrphans = (): void => {
    const en = lang() === 'en';
    for (const a of store.getState().automations) {
      if (a.finishedAt !== null || running.has(a.id) || launching.has(a.id)) continue;
      const tail = a.logFile ? lastMessage(a.logFile) : '';
      if (!a.pid || !processAlive(a.pid)) {
        const why = en
          ? 'Claude stopped without reporting a result (the app was closed or restarted while it ran).'
          : 'Claude se detuvo sin reportar el resultado (la app se cerró o reinició mientras corría).';
        log.warn('claude.orphan', { id: a.id, target: a.target, pid: a.pid, reason: 'process gone' });
        closeUnreported(a.id, [why, tail].filter(Boolean).join('\n'));
      } else if (Date.now() - a.startedAt > MAX_RUN_MS) {
        stopPid(a.pid);
        log.warn('claude.orphan', { id: a.id, target: a.target, pid: a.pid, reason: 'time limit' });
        closeUnreported(a.id, en ? 'Stopped: it ran longer than the time limit.' : 'Detenida: superó el tiempo máximo.');
      }
    }
  };
  checkOrphans();
  setInterval(checkOrphans, ORPHAN_CHECK_MS).unref();

  /** Answer to a launch: the run (200) or, if its site was busy, its place in the queue (202). */
  const sendLaunch = (res: express.Response, result: Awaited<ReturnType<typeof requestLaunch>>): void => {
    // `position` is only in the queued answer (an Automation has a `queued` field of its own).
    res.status(result && 'position' in result ? 202 : 200).json(result);
  };

  api.post('/orchestrator/:key', async (req, res) => {
    const body = (req.body ?? {}) as { fullCoverage?: unknown };
    sendLaunch(res, await requestLaunch(orchestratorSpec(String(req.params.key), body.fullCoverage === true)));
  });

  api.post('/regression', async (req, res) => {
    const body = (req.body ?? {}) as { run?: unknown; dryRun?: unknown };
    const run = typeof body.run === 'string' ? body.run.trim() : '';
    sendLaunch(res, await requestLaunch(regressionSpec(run, body.dryRun === true)));
  });

  api.post('/smoke', async (req, res) => {
    const { site } = (req.body ?? {}) as { site?: unknown };
    sendLaunch(res, await requestLaunch(smokeSpec(site)));
  });


  /** "Validate all": queues the chosen tickets, each on its site's lane, in the app's order. */
  api.post('/queue', async (req, res) => {
    const { keys } = z.object({ keys: z.array(z.string().trim().max(50)).min(1).max(100) }).parse(req.body);
    const check = assertCanLaunch('orchestrator');
    if (check) await check;
    const wanted = new Set(keys);
    const chosen = ticketsToValidate(store.getState()).filter((c) => wanted.has(c.ticket.key));
    if (chosen.length === 0) throw new HttpError(409, 'None of those tickets can be queued (not ready, already running or already queued)');
    const [first] = store.enqueue(chosen.map((c) => ({ kind: 'orchestrator', target: c.ticket.key, site: c.site.id, dryRun: false })));
    log.info('queue.add', { batch: first?.batch, tickets: chosen.map((c) => `${c.ticket.key}@${c.site.id}`).join(',') });
    pump();
    res.json(fullState());
  });

  api.delete('/queue/:id', (req, res) => {
    const item = store.getState().queue.items.find((q) => q.id === String(req.params.id));
    if (!store.dequeue(String(req.params.id))) throw new HttpError(404, 'That run is no longer queued');
    log.info('queue.remove', { kind: item?.kind, target: item?.target, site: item?.site });
    res.json(fullState());
  });

  api.post('/queue/:id/move', (req, res) => {
    const { direction } = z.object({ direction: z.enum(['up', 'down']) }).parse(req.body);
    if (!store.moveQueued(String(req.params.id), direction)) throw new HttpError(404, 'That run is no longer queued');
    res.json(fullState());
  });

  /** Lets a stopped lane go on (after fixing what kept Claude from starting). */
  api.post('/queue/resume', (req, res) => {
    const { site } = z.object({ site: z.string().max(100) }).parse(req.body);
    store.setLanePaused(site, null);
    resumedAt.set(site, Date.now());
    log.info('queue.resume', { site });
    pump();
    res.json(fullState());
  });

  api.post(['/automation/:id/result', '/automation/:id/result/:key'], (req, res) => {
    const id = String(req.params.id);
    // Only the Claude process this run launched has its key (the last segment of the report URL in its prompt).
    const key = typeof req.params.key === 'string' ? req.params.key : '';
    if (store.getAutomation(id) && !store.acceptsReportKey(id, key)) throw new HttpError(403, 'Invalid or missing report key');
    res.json(complete(id, automationResultSchema.parse(req.body)));
  });

  /** What Claude is doing, to follow the run from the app. */
  api.get('/automation/:id/activity', (req, res) => {
    const automation = store.getAutomation(String(req.params.id));
    if (!automation) throw new HttpError(404, 'That run no longer exists');
    res.json({ items: automation.logFile ? readActivity(automation.logFile) : [], logFile: automation.logFile });
  });

  /** Translates the report into the requested language (or the app's) if Claude wrote it in another. */
  api.post('/automation/:id/translate', async (req, res) => {
    const id = String(req.params.id);
    if (!store.getAutomation(id)) throw new HttpError(404, 'That run no longer exists');
    const { lang: to = lang() } = (req.body ?? {}) as { lang?: Lang };
    const target: Lang = to === 'en' ? 'en' : 'es';
    failedTranslations.delete(`${id}:${target}`);
    res.json(await translateOne(id, target));
  });

  /** Comments being posted: a second click while Jira is answering does not post another one. */
  const posting = new Set<string>();

  /** Posts to Jira the QA comment Claude left ready (with the edited text, if sent). */
  api.post('/automation/:id/jira-comment', async (req, res) => {
    const id = String(req.params.id);
    const comment = store.getAutomation(id)?.details?.jiraComment;
    if (!comment) throw new HttpError(404, 'This run has no Jira comment');
    if (comment.posted || posting.has(id)) throw new HttpError(409, 'That comment is already posted on Jira');
    if (comment.dismissed) throw new HttpError(409, 'That comment is dismissed; restore it to post it');
    const { body } = (req.body ?? {}) as { body?: unknown };
    const text = typeof body === 'string' && body.trim() ? body.trim().slice(0, 30000) : comment.body;
    posting.add(id);
    try {
      const url = await postJiraComment(store.getJiraCredentials(), comment.key, text, options.fetchImpl);
      log.info('jira.comment', { key: comment.key, run: id });
      res.json(store.saveJiraCommentPosted(id, text, url));
    } finally {
      posting.delete(id);
    }
  });

  /** QA assistant: answers about the app's data and proposes actions the user confirms. */
  const askAssistant = options.assistant ?? runAssistant;
  const chatSchema = z.object({
    messages: z
      .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().trim().min(1).max(8000) }))
      .min(1)
      .max(40)
      .refine((m) => m.at(-1)?.role === 'user', 'The last message must be from the user'),
  });
  api.post('/assistant', async (req, res) => {
    const { messages } = chatSchema.parse(req.body);
    const state = store.getState();
    const context = assistantContext(state);
    const raw = await askAssistant({
      system: assistantSystem(state.settings.language),
      prompt: assistantPrompt(context, messages),
      schema: ASSISTANT_SCHEMA,
      context,
      messages,
      lang: state.settings.language,
    });
    const reply = parseAssistantReply(raw, store.getState());
    if (!reply.reply && reply.actions.length === 0) throw new HttpError(502, 'The assistant could not answer: empty answer');
    res.json(reply);
  });

  /** Dismisses the Jira comment (e.g. another one was posted by hand) or restores it with `{dismissed: false}`. */
  api.post('/automation/:id/jira-comment/dismiss', (req, res) => {
    const id = String(req.params.id);
    const comment = store.getAutomation(id)?.details?.jiraComment;
    if (!comment) throw new HttpError(404, 'This run has no Jira comment');
    if (comment.posted) throw new HttpError(409, 'That comment is already posted on Jira');
    const { dismissed = true } = (req.body ?? {}) as { dismissed?: unknown };
    res.json(store.setJiraCommentDismissed(id, dismissed !== false));
  });

  /** Edits the bugs of a finished report (key, link, title, severity, module), add or remove some. */
  api.put('/automation/:id/bugs', (req, res) => {
    const id = String(req.params.id);
    const automation = store.getAutomation(id);
    if (!automation) throw new HttpError(404, 'That run no longer exists');
    if (automation.finishedAt === null) throw new HttpError(409, 'That run is still in progress');
    const { lang: shownIn, bugs } = reportBugsEditSchema.parse(req.body);
    res.json(store.updateReportBugs(id, shownIn, bugs));
  });

  /** Stops a running run; it is closed as BLOCKED. */
  api.post('/automation/:id/stop', (req, res) => {
    const id = String(req.params.id);
    const automation = store.getAutomation(id);
    if (!automation) throw new HttpError(404, 'That run no longer exists');
    if (automation.finishedAt !== null) throw new HttpError(409, 'That run already has a result');
    stopProcess(id);
    log.info('claude.stop', { id, target: automation.target });
    closeUnreported(id, lang() === 'en' ? 'Stopped from QA Dashboard.' : 'Detenida desde QA Dashboard.');
    res.json(store.getAutomation(id));
  });

  api.delete('/automation/:id', (req, res) => {
    const id = String(req.params.id);
    const automation = store.getAutomation(id);
    if (automation?.finishedAt === null) stopProcess(id);
    if (!store.deleteAutomation(id)) throw new HttpError(404, 'That run no longer exists');
    log.info('claude.delete', { id, target: automation?.target, running: automation?.finishedAt === null || undefined });
    pump();
    res.status(204).end();
  });

  api.use((_req, _res, next) => {
    next(new HttpError(404, 'Not found'));
  });

  app.use('/api', api);
  if (options.clientDir) app.use(express.static(options.clientDir));
  app.use(errorHandler(lang, log));
  return app;
}
