import { BrowserWindow, app, dialog, shell } from 'electron';
import path from 'node:path';
import { APP_NAME, DEFAULT_PORT, HOST, defaultDataDir, startServer } from '../server/start.js';

/**
 * App de escritorio: arranca el mismo servidor local dentro del proceso de
 * Electron y muestra la interfaz en una ventana propia (sin terminal ni navegador).
 */
const PORT = Number(process.env.QA_DASH_PORT ?? DEFAULT_PORT);
const URL_ = `http://${HOST}:${PORT}`;

app.setName(APP_NAME);
// La caché de Chromium va en una subcarpeta para no mezclarse con qa-tests.json.
app.setPath('sessionData', path.join(defaultDataDir(), 'electron'));

/** ¿Ya hay una instancia de la app (p. ej. `npm start`) sirviendo la interfaz en ese puerto? */
async function existingAppServes(): Promise<boolean> {
  try {
    const [page, api] = await Promise.all([fetch(URL_), fetch(`${URL_}/api/state`)]);
    return page.ok && (page.headers.get('content-type') ?? '').includes('text/html') && api.ok;
  } catch {
    return false;
  }
}

/** Arranca el servidor o reutiliza uno que ya esté abierto (dos servidores sobre el mismo archivo se pisarían). */
async function ensureServer(): Promise<void> {
  try {
    await startServer({ port: PORT, dataDir: defaultDataDir(), clientDir: path.join(app.getAppPath(), 'dist/client') });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && (await existingAppServes())) return;
    throw err;
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());

  // Los enlaces externos (tickets de Jira) se abren en el navegador, no dentro de la app.
  const isInternal = (url: string) => url.startsWith(URL_);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isInternal(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  void win.loadURL(URL_);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app
    .whenReady()
    .then(ensureServer)
    .then(createWindow)
    .catch((err: unknown) => {
      const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
      dialog.showErrorBox(
        APP_NAME,
        busy
          ? `El puerto ${PORT} está ocupado por otro programa. Ciérralo o abre la app con QA_DASH_PORT=8770.`
          : `No se pudo iniciar la app:\n${String(err)}`,
      );
      app.quit();
    });
}
