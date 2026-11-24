import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { ZodError, z } from 'zod';
import { HttpError } from './errors.js';
import { translateError } from './i18n.js';
import type { Automation, AutomationDetails, Lang, QueueItem } from '../shared/types.js';
import { fetchJiraTickets, postJiraComment } from './jira.js';
import { orList, orchestratorPrompt, regressionPrompt, smokePrompt } from './orchestrator.js';
import {
  MAX_RUN_MS, isClaudeProcess, lastMessage, launchClaude, readActivity, runAssistant, stopPid, translateReport,
  type ClaudeHandle, type ClaudeLauncher, type ReportTranslator,
} from './claudeRunner.js';
import { ASSISTANT_SCHEMA, assistantContext, assistantPrompt, assistantSystem, parseAssistantReply, type AssistantRunner } from './assistant.js';
import { findSite, isTicketKey, readyStatuses, siteForStatus } from '../shared/orchestrator.js';
import { isEnvironmentBlock, isUsageLimit, laneOf, queuePosition, ticketsToValidate } from '../shared/queue.js';
import { VERDICTS_BY_KIND, automationTitle, reportInstruction, runForAutomation } from './automation.js';
import {
  automationResultSchema, backupSchema, type AutomationResult, jiraConfigSchema, reportBugsEditSchema, reportTranslationSchema, runInputSchema, settingsSchema,
} from './schemas.js';
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
}

/** Default pause between runs on a site, so Chrome and the site settle before the next one. */
const LANE_GAP_MS = 30_000;

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

const errorHandler = (lang: () => Lang): ErrorRequestHandler => (err, _req, res, _next) => {
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
    send(err.status, err.message);
    return;
  }
  if (err instanceof SyntaxError) {
    send(400, 'Invalid JSON');
    return;
  }
  console.error(err);
  send(500, 'Internal app error');
};

export function createApp(store: Store, options: AppOptions = {}): Express {
  const lang = (): Lang => store.getState().settings.language;
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

  api.get('/state', (_req, res) => {
    res.json({ ...store.getState(), translating: translating.size, demo: options.demo === true });
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
    if (!store.deleteRun(String(req.params.id))) throw new HttpError(404, 'That test run no longer exists');
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

  api.post('/import', (req, res) => {
    const before = lang();
    store.importBackup(backupSchema.parse(req.body));
    if (lang() !== before) translateAll(lang());
    res.json({ ...store.getState(), translating: translating.size, demo: options.demo === true });
  });

  api.put('/jira/config', (req, res) => {
    store.saveJiraConfig(jiraConfigSchema.parse(req.body));
    res.json(store.getJiraState());
  });

  api.post('/jira/refresh', async (_req, res) => {
    try {
      store.saveJiraTickets(await fetchJiraTickets(store.getJiraCredentials(), options.fetchImpl));
    } catch (err) {
      // Only Jira failures change the connection state; "not configured yet" is not a failed connection.
      if (err instanceof HttpError && err.status === 502) store.saveJiraError(translateError(err.message, lang()));
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
    if (finished) afterFinish(finished);
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
  const orchestratorSpec = (key: string): LaunchSpec => {
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
      input: { kind: 'orchestrator', target: key, env: site.env, title, site: site.id, ticketType: ticket.type },
      prompt: (extra) => orchestratorPrompt(key, qa, extra),
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
    item.kind === 'orchestrator' ? orchestratorSpec(item.target) : item.kind === 'smoke' ? smokeSpec(item.site) : regressionSpec(item.target, item.dryRun);

  /** Launches Claude Code in the background and leaves the run "in progress" until it reports the result. */
  const launchAutomation = async ({ input, prompt }: LaunchSpec) => {
    prompt(''); // Validate before recording anything.
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
    } catch (err) {
      store.deleteAutomation(automation.id);
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
    const { automations, queue } = store.getState();
    // A double click does not launch or queue the same run twice.
    if (automations.some((a) => a.finishedAt === null && a.kind === kind && a.target === target)) {
      throw new HttpError(409, `There is already a run in progress for ${runLabel(kind, target)}`);
    }
    if (queue.items.some((q) => q.kind === kind && q.target === target)) throw new HttpError(409, `${runLabel(kind, target)} is already queued`);
    if (laneBusy(site) || queue.items.some((q) => q.site === site)) {
      const [queued] = store.enqueue([{ kind, target, site, dryRun: spec.input.dryRun ?? false }]);
      return { queued: queued!, position: queuePosition(store.getState().queue.items, queued!) };
    }
    return launchAutomation(spec);
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
      } catch (err) {
        store.recordSkip(item, message(err));
        return;
      }
      try {
        await launchAutomation({ ...spec, input: { ...spec.input, queued: { batch: item.batch, retries: item.retries } } });
      } catch (err) {
        if (err instanceof HttpError && err.status < 500) store.recordSkip(item, message(err));
        else {
          // Claude Code could not start: the run waits at the head of its lane until the user resumes it.
          store.requeueFirst(item);
          store.setLanePaused(item.site, message(err));
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
      store.enqueue([{ kind: a.kind, target: a.target, site, dryRun: a.dryRun, batch: a.queued.batch, retries: a.queued.retries + 1 }]);
    }
    const waiting = new Set(store.getState().queue.items.map((q) => q.site));
    if (isUsageLimit(a)) {
      const why = en ? `Claude's usage limit was reached: ${a.summary}` : `Se alcanzó el límite de uso de Claude: ${a.summary}`;
      for (const lane of waiting) if (queue.paused[lane] === undefined) store.setLanePaused(lane, why.slice(0, 500));
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
        store.recordBatchDone({ batch, at: Date.now(), verdicts, minutes: Math.max(1, Math.round((to - from) / 60_000)) });
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
        closeUnreported(a.id, [why, tail].filter(Boolean).join('\n'));
      } else if (Date.now() - a.startedAt > MAX_RUN_MS) {
        stopPid(a.pid);
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
    sendLaunch(res, await requestLaunch(orchestratorSpec(String(req.params.key))));
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

  const fullState = () => ({ ...store.getState(), translating: translating.size, demo: options.demo === true });

  /** "Validate all": queues the chosen tickets, each on its site's lane, in the app's order. */
  api.post('/queue', (req, res) => {
    const { keys } = z.object({ keys: z.array(z.string().trim().max(50)).min(1).max(100) }).parse(req.body);
    const wanted = new Set(keys);
    const chosen = ticketsToValidate(store.getState()).filter((c) => wanted.has(c.ticket.key));
    if (chosen.length === 0) throw new HttpError(409, 'None of those tickets can be queued (not ready, already running or already queued)');
    store.enqueue(chosen.map((c) => ({ kind: 'orchestrator', target: c.ticket.key, site: c.site.id, dryRun: false })));
    pump();
    res.json(fullState());
  });

  api.delete('/queue/:id', (req, res) => {
    if (!store.dequeue(String(req.params.id))) throw new HttpError(404, 'That run is no longer queued');
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
    closeUnreported(id, lang() === 'en' ? 'Stopped from QA Dashboard.' : 'Detenida desde QA Dashboard.');
    res.json(store.getAutomation(id));
  });

  api.delete('/automation/:id', (req, res) => {
    const id = String(req.params.id);
    if (store.getAutomation(id)?.finishedAt === null) stopProcess(id);
    if (!store.deleteAutomation(id)) throw new HttpError(404, 'That run no longer exists');
    pump();
    res.status(204).end();
  });

  api.use((_req, _res, next) => {
    next(new HttpError(404, 'Not found'));
  });

  app.use('/api', api);
  if (options.clientDir) app.use(express.static(options.clientDir));
  app.use(errorHandler(lang));
  return app;
}
