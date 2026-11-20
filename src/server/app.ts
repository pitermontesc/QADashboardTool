import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { ZodError, z } from 'zod';
import { HttpError } from './errors.js';
import { translateError } from './i18n.js';
import type { Automation, AutomationDetails, Lang } from '../shared/types.js';
import { fetchJiraTickets, postJiraComment } from './jira.js';
import { orList, orchestratorPrompt, regressionPrompt, smokePrompt } from './orchestrator.js';
import { launchClaude, readActivity, runAssistant, stopPid, translateReport, type ClaudeHandle, type ClaudeLauncher, type ReportTranslator } from './claudeRunner.js';
import { ASSISTANT_SCHEMA, assistantContext, assistantPrompt, assistantSystem, parseAssistantReply, type AssistantRunner } from './assistant.js';
import { findSite, isTicketKey, readyStatuses, siteForStatus } from '../shared/orchestrator.js';
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
}

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
  const host = (req.headers.host ?? '').split(':')[0] ?? '';
  let originOk = true;
  if (req.headers.origin) {
    try {
      originOk = LOCAL_HOSTS.has(new URL(req.headers.origin).hostname);
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

  const api = express.Router();
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
    const job = translate({ summary: automation.summary, details: automation.details ? { ...automation.details, jiraComment: null } : null }, to)
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
      queue = queue.then(async () => {
        translating.delete(key);
        const result = lang() === to ? await translateOne(a.id, to).catch(() => null) : null;
        release(result);
      });
    }
  };
  translateAll(lang());

  api.post('/import', (req, res) => {
    store.importBackup(backupSchema.parse(req.body));
    res.json(store.getState());
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
    return store.finishAutomation(id, { verdict, summary, link, details }, runInput);
  };

  /** Closes as BLOCKED a run whose process ended or was stopped without reporting. */
  const closeUnreported = (id: string, summary: string): void => {
    const automation = store.getAutomation(id);
    if (!automation || automation.finishedAt !== null) return;
    complete(id, automationResultSchema.parse({ verdict: 'BLOCKED', summary: summary.slice(0, 4900) }));
  };

  api.post('/orchestrator/:key', async (req, res) => {
    const key = String(req.params.key);
    if (!isTicketKey(key)) throw new HttpError(400, `Invalid ticket: ${key}`);
    const ticket = store.getJiraState().tickets.find((t) => t.key === key);
    if (!ticket) throw new HttpError(404, `${key} is not among the loaded Jira tickets`);
    const { qa } = store.getState().settings;
    // The Jira status decides which site is tested (On QA → QA, On Staging → STG, per the settings).
    const site = siteForStatus(ticket.status, qa);
    if (!site) {
      throw new HttpError(409, `${key} is in "${ticket.status}"; the orchestrator is for tickets in ${orList(readyStatuses(qa))}`);
    }
    const title = automationTitle('orchestrator', key, lang(), ticket.summary);
    res.json(await launchAutomation(req, { kind: 'orchestrator', target: key, env: site.env, title }, (extra) => orchestratorPrompt(key, qa, extra)));
  });

  /** Launches Claude Code in the background and leaves the run "in progress" until it reports the result. */
  const launchAutomation = async (
    req: express.Request,
    input: Parameters<Store['startAutomation']>[0],
    prompt: (extra: string) => string,
  ) => {
    prompt(''); // Validate before recording anything.
    // A double click does not launch two Claude processes on the same target; another site or ticket can run at the same time.
    const busy = store.getState().automations.find((a) => a.finishedAt === null && a.kind === input.kind && a.target === input.target);
    if (busy) throw new HttpError(409, `There is already a run in progress for ${input.kind === 'orchestrator' ? input.target : `${input.kind} ${input.target}`.trim()}`);
    const settings = store.getState().settings;
    const automation = store.startAutomation(input, (a) => runInputSchema.parse(runForAutomation(a, settings)));
    const en = settings.language === 'en';
    try {
      const handle = await launch({
        id: automation.id,
        prompt: prompt(reportInstruction(input.kind, req.socket.localPort ?? 0, automation.id, settings.language)),
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
    }
    return store.getAutomation(automation.id);
  };

  /** Stops a run's process, whether this server or a previous one launched it. */
  const stopProcess = (id: string): void => {
    const handle = running.get(id);
    if (handle) handle.stop();
    else {
      const pid = store.getAutomation(id)?.pid;
      if (pid) stopPid(pid);
    }
    running.delete(id);
  };

  api.post('/regression', async (req, res) => {
    const body = (req.body ?? {}) as { run?: unknown; dryRun?: unknown };
    const run = typeof body.run === 'string' ? body.run.trim() : '';
    const dryRun = body.dryRun === true;
    const { qa } = store.getState().settings;
    const env = findSite(qa.regressionSiteId, qa)?.env ?? '';
    const title = automationTitle('regression', run, lang(), '', dryRun);
    res.json(await launchAutomation(req, { kind: 'regression', target: run, env, title, dryRun }, (extra) => regressionPrompt(run, qa, extra, dryRun)));
  });

  api.post('/smoke', async (req, res) => {
    const { site: siteId } = (req.body ?? {}) as { site?: unknown };
    const { qa } = store.getState().settings;
    const site = findSite(siteId, qa);
    if (!site) throw new HttpError(400, `That site does not exist: choose ${orList(qa.sites.map((s) => s.name))}`);
    const title = automationTitle('smoke', site.name, lang());
    res.json(await launchAutomation(req, { kind: 'smoke', target: site.name, env: site.env, title }, (extra) => smokePrompt(site.id, qa, extra)));
  });

  api.post('/automation/:id/result', (req, res) => {
    res.json(complete(String(req.params.id), automationResultSchema.parse(req.body)));
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
