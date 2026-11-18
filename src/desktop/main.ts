import { BrowserWindow, Menu, app, dialog, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { APP_NAME, DEFAULT_PORT, HOST, defaultDataDir, startServer } from '../server/start.js';

/**
 * App de escritorio: arranca el mismo servidor local dentro del proceso de
 * Electron y muestra la interfaz en una ventana propia (sin terminal ni navegador).
 */
const PORT = Number(process.env.QA_DASH_PORT ?? DEFAULT_PORT);
const URL_ = `http://${HOST}:${PORT}`;
const WINDOW_FILE = path.join(defaultDataDir(), 'window.json');

app.setName(APP_NAME);
// Interfaz en español: fechas dd/mm/aaaa en los selectores y textos del sistema en castellano.
app.commandLine.appendSwitch('lang', 'es-ES');
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

interface WindowState { x?: number; y?: number; width: number; height: number; maximized?: boolean }

/** Tamaño y posición de la última sesión, para que la ventana abra donde la dejaste. */
function loadWindowState(): WindowState {
  try {
    const saved = JSON.parse(readFileSync(WINDOW_FILE, 'utf8')) as WindowState;
    if (saved.width >= 900 && saved.height >= 600) return saved;
  } catch {
    // Primera vez o archivo dañado: tamaño por defecto.
  }
  return { width: 1320, height: 880 };
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const state: WindowState = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    mkdirSync(path.dirname(WINDOW_FILE), { recursive: true });
    writeFileSync(WINDOW_FILE, JSON.stringify(state));
  } catch {
    // No guardar la posición no debe impedir cerrar la app.
  }
}

/** Envía un comando del menú a la interfaz (nuevo registro, cambiar de vista, recargar Jira…). */
function sendCommand(command: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  void win?.webContents.executeJavaScript(
    `window.dispatchEvent(new CustomEvent('app-command', { detail: ${JSON.stringify(command)} }))`,
  );
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'Archivo',
      submenu: [
        { label: 'Nuevo registro', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new-run') },
        { type: 'separator' },
        { label: 'Actualizar tickets de Jira', accelerator: 'CmdOrCtrl+R', click: () => sendCommand('refresh-jira') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Ver',
      submenu: [
        { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: () => sendCommand('tab:dash') },
        { label: 'Registros', accelerator: 'CmdOrCtrl+2', click: () => sendCommand('tab:runs') },
        { label: 'Tipos y ajustes', accelerator: 'CmdOrCtrl+3', click: () => sendCommand('tab:config') },
        { label: 'Buscar registros', accelerator: 'CmdOrCtrl+F', click: () => sendCommand('search') },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Tamaño real' },
        { role: 'zoomIn', label: 'Acercar' },
        { role: 'zoomOut', label: 'Alejar' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Pantalla completa' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  const saved = loadWindowState();
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    ...saved,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    show: false,
    // Barra de título integrada: los semáforos de macOS quedan sobre la cabecera de la app.
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 20 },
    // Mismo fondo que la app para que no haya destello blanco al abrir en modo oscuro.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#12151b' : '#f4f5f7',
    icon: path.join(app.getAppPath(), 'build/icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  if (saved.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', () => saveWindowState(win));

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
    .then(() => {
      buildMenu();
      // En desarrollo el Dock mostraría el icono de Electron.
      if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(app.getAppPath(), 'build/icon.png'));
    })
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
