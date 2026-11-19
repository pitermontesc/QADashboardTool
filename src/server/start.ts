import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp, type AppOptions } from './app.js';
import { Store } from './store.js';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 8765;
export const APP_NAME = 'QA Dashboard';

/**
 * Carpeta de datos compartida por todas las formas de abrir la app (navegador
 * o escritorio), en la ubicación estándar del sistema para datos de usuario.
 */
export function defaultDataDir(): string {
  if (process.env.QA_DASH_DATA) return process.env.QA_DASH_DATA;
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_NAME);
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), APP_NAME);
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), APP_NAME);
}

export interface StartOptions {
  port: number;
  dataDir: string;
  /** Carpeta con la interfaz compilada; si no existe solo se sirve la API. */
  clientDir: string;
  /** Opciones de la API (por ejemplo, las del modo demo). */
  appOptions?: Omit<AppOptions, 'clientDir'>;
}

export interface RunningServer {
  url: string;
  dataFile: string;
  hasClient: boolean;
  server: Server;
}

/** Arranca el servidor; rechaza con el error de `listen` (p. ej. EADDRINUSE). */
export function startServer({ port, dataDir, clientDir, appOptions = {} }: StartOptions): Promise<RunningServer> {
  const dataFile = path.join(dataDir, 'qa-tests.json');
  const hasClient = existsSync(clientDir);
  const app = createApp(new Store(dataFile), hasClient ? { ...appOptions, clientDir } : appOptions);
  return new Promise((resolve, reject) => {
    const server = app.listen(port, HOST);
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      resolve({ url: `http://${HOST}:${port}`, dataFile, hasClient, server });
    });
  });
}
