import { BrowserWindow, Menu, app, dialog, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { APP_NAME, DEFAULT_PORT, HOST, defaultDataDir, startServer } from '../server/start.js';
import { DEMO_PORT, demoAppOptions, demoDataDir, seedDemoData } from '../server/demo.js';

/**
 * App de escritorio: arranca el mismo servidor local dentro del proceso de
 * Electron y muestra la interfaz en una ventana propia (sin terminal ni navegador).
 */
const PORT = Number(process.env.QA_DASH_PORT ?? DEFAULT_PORT);
const URL_ = `http://${HOST}:${PORT}`;
const WINDOW_FILE = path.join(defaultDataDir(), 'window.json');

type Lang = 'es' | 'en';

/** Idioma guardado en los ajustes de la app (el archivo se lee antes de arrancar el servidor). */
function savedLanguage(): Lang {
  try {
    const data = JSON.parse(readFileSync(path.join(defaultDataDir(), 'qa-tests.json'), 'utf8')) as { settings?: { language?: string } };
    return data.settings?.language === 'en' ? 'en' : 'es';
  } catch {
    return 'es';
  }
}

let lang: Lang = savedLanguage();

const TEXT = {
  es: {
    file: 'Archivo', newRun: 'Nuevo registro', refreshJira: 'Actualizar tickets de Jira', view: 'Ver',
    dashboard: 'Dashboard', runs: 'Registros', config: 'Tipos y ajustes', search: 'Buscar registros',
    resetZoom: 'Tamaño real', zoomIn: 'Acercar', zoomOut: 'Alejar', fullscreen: 'Pantalla completa',
    portBusy: (port: number) => `El puerto ${port} está ocupado por otro programa. Ciérralo o abre la app con QA_DASH_PORT=8770.`,
    startFailed: 'No se pudo iniciar la app:',
    help: 'Ayuda', openDemo: 'Abrir demo (datos de ejemplo)', demoTitle: `${APP_NAME} · Demo`, demoFailed: 'No se pudo abrir la demo:',
  },
  en: {
    file: 'File', newRun: 'New run', refreshJira: 'Refresh Jira tickets', view: 'View',
    dashboard: 'Dashboard', runs: 'Runs', config: 'Types & settings', search: 'Search runs',
    resetZoom: 'Actual size', zoomIn: 'Zoom in', zoomOut: 'Zoom out', fullscreen: 'Full screen',
    portBusy: (port: number) => `Port ${port} is used by another program. Close it or open the app with QA_DASH_PORT=8770.`,
    startFailed: 'The app could not start:',
    help: 'Help', openDemo: 'Open demo (sample data)', demoTitle: `${APP_NAME} · Demo`, demoFailed: 'The demo could not open:',
  },
};

app.setName(APP_NAME);
// Fechas de los selectores y textos del sistema en el idioma de la app.
app.commandLine.appendSwitch('lang', lang === 'en' ? 'en-US' : 'es-ES');
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

/** Demo en su propio servidor (puerto 8790, datos de ejemplo en una carpeta temporal); se crea una sola vez por sesión. */
let demoUrl: string | null = null;
async function openDemo(): Promise<void> {
  try {
    if (!demoUrl) {
      const url = `http://${HOST}:${DEMO_PORT}`;
      const dataDir = demoDataDir(DEMO_PORT);
      try {
        seedDemoData(dataDir, lang);
        await startServer({ port: DEMO_PORT, dataDir, clientDir: path.join(app.getAppPath(), 'dist/client'), appOptions: demoAppOptions(dataDir) });
      } catch (err) {
        // `npm run demo` ya la está sirviendo: se reutiliza.
        const serving = await fetch(`${url}/api/state`).then((r) => r.ok, () => false);
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || !serving) throw err;
      }
      demoUrl = url;
    }
    createWindow(demoUrl, true);
  } catch (err) {
    dialog.showErrorBox(APP_NAME, `${TEXT[lang].demoFailed}\n${String(err)}`);
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
  const t = TEXT[lang];
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: t.file,
      submenu: [
        { label: t.newRun, accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new-run') },
        { type: 'separator' },
        { label: t.refreshJira, accelerator: 'CmdOrCtrl+R', click: () => sendCommand('refresh-jira') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: t.view,
      submenu: [
        { label: t.dashboard, accelerator: 'CmdOrCtrl+1', click: () => sendCommand('tab:dash') },
        { label: t.runs, accelerator: 'CmdOrCtrl+2', click: () => sendCommand('tab:runs') },
        { label: t.config, accelerator: 'CmdOrCtrl+3', click: () => sendCommand('tab:config') },
        { label: t.search, accelerator: 'CmdOrCtrl+F', click: () => sendCommand('search') },
        { type: 'separator' },
        { role: 'resetZoom', label: t.resetZoom },
        { role: 'zoomIn', label: t.zoomIn },
        { role: 'zoomOut', label: t.zoomOut },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t.fullscreen },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
      ],
    },
    { role: 'windowMenu' },
    { role: 'help', label: t.help, submenu: [{ label: t.openDemo, click: () => void openDemo() }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(url = URL_, demo = false): void {
  // La demo abre en una ventana aparte y no toca la posición guardada de la principal.
  const saved = demo ? { width: 1320, height: 880 } : loadWindowState();
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    ...saved,
    minWidth: 900,
    minHeight: 600,
    title: demo ? TEXT[lang].demoTitle : APP_NAME,
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
  if (!demo) win.on('close', () => saveWindowState(win));

  // Los enlaces externos (tickets de Jira) se abren en el navegador, no dentro de la app.
  const isInternal = (target: string) => target.startsWith(url);
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!isInternal(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (!isInternal(target)) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });

  void win.loadURL(url);

  // Al cambiar el idioma en la interfaz (atributo lang de la página) se rehace el menú.
  const timer = setInterval(() => {
    if (win.isDestroyed()) return;
    win.webContents
      .executeJavaScript('document.documentElement.lang')
      .then((value: unknown) => {
        if ((value === 'es' || value === 'en') && value !== lang) {
          lang = value;
          buildMenu();
        }
      })
      .catch(() => undefined);
  }, 1500);
  win.on('closed', () => clearInterval(timer));
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
    .then(() => (process.argv.includes('--demo') ? openDemo() : createWindow()))
    .catch((err: unknown) => {
      const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
      dialog.showErrorBox(
        APP_NAME,
        busy
          ? TEXT[lang].portBusy(PORT)
          : `${TEXT[lang].startFailed}\n${String(err)}`,
      );
      app.quit();
    });
}
