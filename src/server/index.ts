import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, HOST, defaultDataDir, startServer } from './start.js';
import { DEMO_PORT, demoAppOptions, demoDataDir, seedDemoData } from './demo.js';

/** `--demo`: datos de ejemplo en una carpeta temporal y Jira/Claude simulados (`--lang en` para empezar en inglés). */
const DEMO = process.argv.includes('--demo');
const PORT = Number(process.env.QA_DASH_PORT ?? (DEMO ? DEMO_PORT : DEFAULT_PORT));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const URL_ = `http://${HOST}:${PORT}`;
const shouldOpen = process.argv.includes('--open');

/** Abre la app en su propia ventana (modo app de Chrome en macOS) o en el navegador por defecto. */
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
    .on('error', () => console.log(`Abre ${URL_} en tu navegador.`))
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
  console.log(`QA Test Dashboard${DEMO ? ' (DEMO: datos de ejemplo, Jira y Claude simulados)' : ''} en ${URL_}`);
  console.log(`Datos: ${dataFile}`);
  if (!hasClient) console.log('Interfaz sin compilar: usa "npm run dev" o "npm start".');
  console.log('Deja esta ventana abierta; Ctrl+C cierra la app.');
  if (shouldOpen && hasClient) openWindow();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`El puerto ${PORT} ya está en uso (¿la app ya está abierta?). Otro puerto: QA_DASH_PORT=8770 npm start`);
    if (shouldOpen) openWindow();
    process.exit(1);
  }
  throw err;
}
