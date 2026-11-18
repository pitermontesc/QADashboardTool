import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from './errors.js';
import { translateError } from './i18n.js';
import type { Automation, AutomationDetails, Lang } from '../shared/types.js';
import { fetchJiraTickets, postJiraComment } from './jira.js';
import { orchestratorPrompt, regressionPrompt, smokePrompt } from './orchestrator.js';
import { launchClaude, readActivity, stopPid, translateReport, type ClaudeHandle, type ClaudeLauncher, type ReportTranslator } from './claudeRunner.js';
import { SMOKE_SITES, canOrchestrate, isSmokeSite, isTicketKey } from '../shared/orchestrator.js';
import { automationTitle, envFor, reportInstruction, runForAutomation } from './automation.js';
import {
  automationResultSchema, backupSchema, type AutomationResult, jiraConfigSchema, reportTranslationSchema, runInputSchema, settingsSchema,
} from './schemas.js';
import type { Store } from './store.js';

export interface AppOptions {
  /** Carpeta con la interfaz compilada; si se omite solo se sirve la API. */
  clientDir?: string;
  /** Inyectable para probar la integración con Jira sin red. */
  fetchImpl?: typeof fetch;
  /** Inyectable para probar los skills de QA sin ejecutar Claude Code. */
  launchClaude?: ClaudeLauncher;
  /** Inyectable para probar la traducción de reportes sin ejecutar Claude Code. */
  translateReport?: ReportTranslator;
}

/**
 * Reporte traducido sobre el original: de la traducción solo se toman los textos
 * (por posición); estados, minutos, claves y links salen siempre del original.
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
 * La app solo debe responder a esta máquina. Se comprueba el Host (evita DNS
 * rebinding) y el Origin (evita que otra web abierta en el navegador llame a la API).
 */
const localOnly: RequestHandler = (req, res, next) => {
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
    res.status(403).json({ error: 'Solo acceso local · Local access only' });
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
    send(400, `Datos inválidos${field ? ` (${field})` : ''}: ${issue?.message ?? ''}`);
    return;
  }
  if (err instanceof HttpError) {
    send(err.status, err.message);
    return;
  }
  if (err instanceof SyntaxError) {
    send(400, 'JSON inválido');
    return;
  }
  console.error(err);
  send(500, 'Error interno de la app');
};

export function createApp(store: Store, options: AppOptions = {}): Express {
  const lang = (): Lang => store.getState().settings.language;
  const app = express();
  app.disable('x-powered-by');
  app.use(localOnly);

  const api = express.Router();
  api.use(express.json({ limit: '5mb' }));
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  api.get('/state', (_req, res) => {
    res.json({ ...store.getState(), translating: translating.size });
  });

  api.post('/runs', (req, res) => {
    res.status(201).json(store.createRun(runInputSchema.parse(req.body)));
  });

  api.put('/runs/:id', (req, res) => {
    const run = store.updateRun(String(req.params.id), runInputSchema.parse(req.body));
    if (!run) throw new HttpError(404, 'El registro ya no existe');
    res.json(run);
  });

  api.delete('/runs/:id', (req, res) => {
    if (!store.deleteRun(String(req.params.id))) throw new HttpError(404, 'El registro ya no existe');
    res.status(204).end();
  });

  api.put('/settings', (req, res) => {
    const before = lang();
    const settings = store.saveSettings(settingsSchema.parse(req.body));
    if (settings.language !== before) translateAll(settings.language);
    res.json(settings);
  });

  const translate = options.translateReport ?? translateReport;
  /** Traducciones en cola o en curso («id:idioma»); las fallidas no se reintentan solas. */
  const translating = new Map<string, Promise<Automation | null>>();
  const failedTranslations = new Set<string>();
  const needsTranslation = (a: Automation, to: Lang): boolean =>
    a.finishedAt !== null && a.lang !== to && !a.translations[to] && (a.summary !== '' || a.details !== null);

  /** Traduce el resumen y el reporte de una ejecución con Claude y guarda la traducción. */
  const translateOne = (id: string, to: Lang): Promise<Automation | null> => {
    const key = `${id}:${to}`;
    const current = translating.get(key);
    if (current) return current;
    const automation = store.getAutomation(id);
    if (!automation || !needsTranslation(automation, to)) return Promise.resolve(automation);
    // El comentario de Jira no se traduce: va al ticket tal como lo redactó el skill.
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
        throw err instanceof HttpError ? err : new HttpError(502, `No se pudo traducir el reporte: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => translating.delete(key));
    translating.set(key, job);
    return job;
  };

  /** Al cambiar de idioma se traducen, de a una, las ejecuciones que Claude escribió en el otro. */
  let queue: Promise<unknown> = Promise.resolve();
  const translateAll = (to: Lang): void => {
    for (const a of store.getState().automations) {
      const key = `${a.id}:${to}`;
      if (!needsTranslation(a, to) || failedTranslations.has(key) || translating.has(key)) continue;
      let release: (value: Automation | null) => void = () => undefined;
      // Se reserva el lugar en la cola para que el estado cuente las pendientes.
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
      // Solo los fallos de Jira cambian el estado de conexión; "falta configurar" no es una conexión fallida.
      if (err instanceof HttpError && err.status === 502) store.saveJiraError(translateError(err.message, lang()));
      throw err;
    }
    res.json(store.getJiraState());
  });

  const launch = options.launchClaude ?? launchClaude;
  /** Procesos en curso lanzados por este servidor. */
  const running = new Map<string, ClaudeHandle>();

  /** Guarda el resultado de una ejecución y completa su registro. */
  const complete = (id: string, result: AutomationResult) => {
    const automation = store.getAutomation(id);
    if (!automation) throw new HttpError(404, 'Esa ejecución no existe o se descartó');
    if (automation.finishedAt !== null) throw new HttpError(409, 'Esa ejecución ya tiene resultado');
    const { verdict, summary, link, details } = result;
    const runInput = runInputSchema.parse(runForAutomation(automation, store.getState().settings, result));
    return store.finishAutomation(id, { verdict, summary, link, details }, runInput);
  };

  /** Cierra como BLOCKED una ejecución cuyo proceso terminó o se detuvo sin reportar. */
  const closeUnreported = (id: string, summary: string): void => {
    const automation = store.getAutomation(id);
    if (!automation || automation.finishedAt !== null) return;
    complete(id, automationResultSchema.parse({ verdict: 'BLOCKED', summary: summary.slice(0, 4900) }));
  };

  api.post('/orchestrator/:key', async (req, res) => {
    const key = String(req.params.key);
    if (!isTicketKey(key)) throw new HttpError(400, `Ticket inválido: ${key}`);
    const ticket = store.getJiraState().tickets.find((t) => t.key === key);
    if (!ticket) throw new HttpError(404, `${key} no está entre los tickets cargados de Jira`);
    if (!canOrchestrate(ticket.status)) {
      throw new HttpError(409, `${key} está en "${ticket.status}"; el orquestador es para tickets On QA u On Staging`);
    }
    const env = envFor(/stag/i.test(ticket.status) ? 'staging' : 'qa', store.getState().settings);
    const title = automationTitle('orchestrator', key, lang(), ticket.summary);
    res.json(await launchAutomation(req, { kind: 'orchestrator', target: key, env, title }, (extra) => orchestratorPrompt(key, extra)));
  });

  /** Lanza Claude Code en segundo plano y deja la ejecución «en curso» hasta que reporte el resultado. */
  const launchAutomation = async (
    req: express.Request,
    input: Parameters<Store['startAutomation']>[0],
    prompt: (extra: string) => string,
  ) => {
    prompt(''); // Valida antes de registrar nada.
    const settings = store.getState().settings;
    const automation = store.startAutomation(input, (a) => runInputSchema.parse(runForAutomation(a, settings)));
    const en = settings.language === 'en';
    try {
      const handle = await launch({
        id: automation.id,
        prompt: prompt(reportInstruction(input.kind, req.socket.localPort ?? 0, automation.id, settings.language)),
        onExit: ({ code, lastMessage }) => {
          running.delete(automation.id);
          // Claude reporta con un POST antes de terminar; si no lo hizo, la ejecución no queda «en curso» para siempre.
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

  /** Detiene el proceso de una ejecución, lo haya lanzado este servidor o uno anterior. */
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
    const body = (req.body ?? {}) as { run?: unknown };
    const run = typeof body.run === 'string' ? body.run.trim() : '';
    const env = envFor('staging', store.getState().settings);
    const title = automationTitle('regression', run, lang());
    res.json(await launchAutomation(req, { kind: 'regression', target: run, env, title }, (extra) => regressionPrompt(run, extra)));
  });

  api.post('/smoke', async (req, res) => {
    const { site } = (req.body ?? {}) as { site?: unknown };
    if (!isSmokeSite(site)) throw new HttpError(400, 'Elige el sitio del smoke: QA o STG');
    const env = envFor(site === 'qa' ? 'qa' : 'staging', store.getState().settings);
    const { label } = SMOKE_SITES[site];
    res.json(await launchAutomation(req, { kind: 'smoke', target: label, env, title: automationTitle('smoke', label, lang()) }, (extra) => smokePrompt(site, extra)));
  });

  api.post('/automation/:id/result', (req, res) => {
    res.json(complete(String(req.params.id), automationResultSchema.parse(req.body)));
  });

  /** Lo que va haciendo Claude, para seguir la ejecución desde la app. */
  api.get('/automation/:id/activity', (req, res) => {
    const automation = store.getAutomation(String(req.params.id));
    if (!automation) throw new HttpError(404, 'Esa ejecución ya no existe');
    res.json({ items: automation.logFile ? readActivity(automation.logFile) : [], logFile: automation.logFile });
  });

  /** Traduce el reporte al idioma pedido (o al de la app) si Claude lo escribió en otro. */
  api.post('/automation/:id/translate', async (req, res) => {
    const id = String(req.params.id);
    if (!store.getAutomation(id)) throw new HttpError(404, 'Esa ejecución ya no existe');
    const { lang: to = lang() } = (req.body ?? {}) as { lang?: Lang };
    const target: Lang = to === 'en' ? 'en' : 'es';
    failedTranslations.delete(`${id}:${target}`);
    res.json(await translateOne(id, target));
  });

  /** Publica en Jira el comentario de QA que Claude dejó listo (con el texto editado, si se envía). */
  api.post('/automation/:id/jira-comment', async (req, res) => {
    const id = String(req.params.id);
    const comment = store.getAutomation(id)?.details?.jiraComment;
    if (!comment) throw new HttpError(404, 'Esta ejecución no tiene comentario para Jira');
    if (comment.posted) throw new HttpError(409, 'Ese comentario ya está publicado en Jira');
    const { body } = (req.body ?? {}) as { body?: unknown };
    const text = typeof body === 'string' && body.trim() ? body.trim().slice(0, 30000) : comment.body;
    const url = await postJiraComment(store.getJiraCredentials(), comment.key, text, options.fetchImpl);
    res.json(store.saveJiraCommentPosted(id, text, url));
  });

  /** Detiene una ejecución en curso; queda como BLOCKED. */
  api.post('/automation/:id/stop', (req, res) => {
    const id = String(req.params.id);
    const automation = store.getAutomation(id);
    if (!automation) throw new HttpError(404, 'Esa ejecución ya no existe');
    if (automation.finishedAt !== null) throw new HttpError(409, 'Esa ejecución ya tiene resultado');
    stopProcess(id);
    closeUnreported(id, lang() === 'en' ? 'Stopped from QA Dashboard.' : 'Detenida desde QA Dashboard.');
    res.json(store.getAutomation(id));
  });

  api.delete('/automation/:id', (req, res) => {
    const id = String(req.params.id);
    if (store.getAutomation(id)?.finishedAt === null) stopProcess(id);
    if (!store.deleteAutomation(id)) throw new HttpError(404, 'Esa ejecución ya no existe');
    res.status(204).end();
  });

  api.use((_req, _res, next) => {
    next(new HttpError(404, 'No encontrado'));
  });

  app.use('/api', api);
  if (options.clientDir) app.use(express.static(options.clientDir));
  app.use(errorHandler(lang));
  return app;
}
