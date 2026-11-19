import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, HOST, defaultDataDir, startServer } from './start.js';
import { DEMO_PORT, demoAppOptions, demoDataDir, seedDemoData } from './demo.js';

/** `--demo`: sample data in a temporary folder and simulated Jira/Claude (`--lang en` to start in English). */
const DEMO = process.argv.includes('--demo');
const PORT = Number(process.env.QA_DASH_PORT ?? (DEMO ? DEMO_PORT : DEFAULT_PORT));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const URL_ = `http://${HOST}:${PORT}`;
const shouldOpen = process.argv.includes('--open');

/** Opens the app in its own window (Chrome app mode on macOS) or in the default browser. */
function openWindow(): void {
  const chrome = '/Applications/Google Chrome.app';
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin'
      ? existsSync(chrome)
        ? ['open', ['-na', 'Google Chrome', '--args', `--app=${URL_}`]]
        : ['open', [URL_]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', URL_]]
        : ['xdg-open', [URL_]];
  spawn(cmd, args, { stdio: 'ignore', detached: true })
    .on('error', () => console.log(`Open ${URL_} in your browser.`))
    .unref();
}

try {
  const dataDir = DEMO ? demoDataDir(PORT) : defaultDataDir();
  if (DEMO) seedDemoData(dataDir, process.argv.includes('en') ? 'en' : 'es');
  const { dataFile, hasClient } = await startServer({
    port: PORT,
    dataDir,
    clientDir: path.join(ROOT, 'dist/client'),
    appOptions: DEMO ? demoAppOptions(dataDir) : {},
  });
  console.log(`QA Test Dashboard${DEMO ? ' (DEMO: sample data, simulated Jira and Claude)' : ''} at ${URL_}`);
  console.log(`Data: ${dataFile}`);
  if (!hasClient) console.log('UI not built: use "npm run dev" or "npm start".');
  console.log('Keep this window open; Ctrl+C closes the app.');
  if (shouldOpen && hasClient) openWindow();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use (is the app already open?). Another port: QA_DASH_PORT=8770 npm start`);
    if (shouldOpen) openWindow();
    process.exit(1);
  }
  throw err;
}
