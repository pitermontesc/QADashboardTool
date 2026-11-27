import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp, type AppOptions } from './app.js';
import { appVersion } from './updates.js';

export { appVersion };
import { appLog } from './log.js';
import { Store } from './store.js';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 8765;
export const APP_NAME = 'QA Dashboard';

/**
 * Data folder shared by every way of opening the app (browser or desktop),
 * in the system's standard location for user data.
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
  /** Folder with the built UI; if it does not exist, only the API is served. */
  clientDir: string;
  /** API options (for example, the demo mode ones). */
  appOptions?: Omit<AppOptions, 'clientDir'>;
}

export interface RunningServer {
  url: string;
  dataFile: string;
  hasClient: boolean;
  server: Server;
}

/** Starts the server; rejects with the `listen` error (e.g. EADDRINUSE). */
export function startServer({ port, dataDir, clientDir, appOptions = {} }: StartOptions): Promise<RunningServer> {
  const dataFile = path.join(dataDir, 'qa-tests.json');
  const hasClient = existsSync(clientDir);
  const log = appLog(dataDir);
  const app = createApp(new Store(dataFile, log), hasClient ? { ...appOptions, clientDir } : appOptions);
  return new Promise((resolve, reject) => {
    const server = app.listen(port, HOST);
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      log.info('app.start', { version: appVersion(), port, demo: appOptions.demo || undefined, node: process.versions.node, electron: process.versions.electron });
      resolve({ url: `http://${HOST}:${port}`, dataFile, hasClient, server });
    });
  });
}
