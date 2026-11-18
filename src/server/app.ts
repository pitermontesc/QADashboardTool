import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from './errors.js';
import { fetchJiraTickets } from './jira.js';
import { backupSchema, jiraConfigSchema, runInputSchema, settingsSchema } from './schemas.js';
import type { Store } from './store.js';

export interface AppOptions {
  /** Carpeta con la interfaz compilada; si se omite solo se sirve la API. */
  clientDir?: string;
  /** Inyectable para probar la integración con Jira sin red. */
  fetchImpl?: typeof fetch;
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
    res.status(403).json({ error: 'Solo acceso local' });
    return;
  }
  next();
};

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    const field = issue?.path.join('.');
    res.status(400).json({ error: `Datos inválidos${field ? ` (${field})` : ''}: ${issue?.message ?? ''}` });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof SyntaxError) {
    res.status(400).json({ error: 'JSON inválido' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Error interno de la app' });
};

export function createApp(store: Store, options: AppOptions = {}): Express {
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
    res.json(store.getState());
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
    res.json(store.saveSettings(settingsSchema.parse(req.body)));
  });

  api.post('/import', (req, res) => {
    store.importBackup(backupSchema.parse(req.body));
    res.json(store.getState());
  });

  api.put('/jira/config', (req, res) => {
    store.saveJiraConfig(jiraConfigSchema.parse(req.body));
    res.json(store.getJiraState());
  });

  api.post('/jira/refresh', async (_req, res) => {
    store.saveJiraTickets(await fetchJiraTickets(store.getJiraCredentials(), options.fetchImpl));
    res.json(store.getJiraState());
  });

  api.use((_req, _res, next) => {
    next(new HttpError(404, 'No encontrado'));
  });

  app.use('/api', api);
  if (options.clientDir) app.use(express.static(options.clientDir));
  app.use(errorHandler);
  return app;
}
