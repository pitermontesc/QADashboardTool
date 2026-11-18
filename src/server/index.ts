import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { Store } from './store.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.QA_DASH_PORT ?? 8765);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_FILE = path.join(process.env.QA_DASH_DATA ?? path.join(ROOT, 'data'), 'qa-tests.json');
const CLIENT_DIR = path.join(ROOT, 'dist/client');
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

const hasClient = existsSync(CLIENT_DIR);
const app = createApp(new Store(DATA_FILE), hasClient ? { clientDir: CLIENT_DIR } : {});

const server = app.listen(PORT, HOST, () => {
  console.log(`QA Test Dashboard en ${URL_}`);
  console.log(`Datos: ${DATA_FILE}`);
  if (!hasClient) console.log('Interfaz sin compilar: usa "npm run dev" o "npm start".');
  console.log('Deja esta ventana abierta; Ctrl+C cierra la app.');
  if (shouldOpen && hasClient) openWindow();
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`El puerto ${PORT} ya está en uso (¿la app ya está abierta?). Otro puerto: QA_DASH_PORT=8770 npm start`);
    if (shouldOpen) openWindow();
    process.exit(1);
  }
  throw err;
});
