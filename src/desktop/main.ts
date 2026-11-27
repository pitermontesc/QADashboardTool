import { BrowserWindow, Menu, app, dialog, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { APP_NAME, DEFAULT_PORT, HOST, defaultDataDir, startServer } from '../server/start.js';
import { appLog } from '../server/log.js';
import { DEMO_PORT, demoAppOptions, demoDataDir, seedDemoData } from '../server/demo.js';

/**
 * Desktop app: starts the same local server inside the Electron process and
 * shows the UI in its own window (no terminal or browser needed).
 */
const PORT = Number(process.env.QA_DASH_PORT ?? DEFAULT_PORT);
const URL_ = `http://${HOST}:${PORT}`;
const WINDOW_FILE = path.join(defaultDataDir(), 'window.json');
/** Same log as the server's (`logs/app.log` in the data folder). */
const log = appLog(defaultDataDir());

// What fails outside a request (a timer, a queued run starting) is kept in the log too.
process.on('unhandledRejection', (reason) => log.error('app.unhandled-rejection', reason));
process.on('uncaughtException', (err) => {
  log.error('app.crash', err);
  dialog.showErrorBox(APP_NAME, String(err));
});

type Lang = 'es' | 'en';
type Theme = 'system' | 'light' | 'dark';

/** Saved app settings (the file is read before the server starts). */
function savedSettings(): { language?: string; theme?: string } {
  try {
    const data = JSON.parse(readFileSync(path.join(defaultDataDir(), 'qa-tests.json'), 'utf8')) as { settings?: { language?: string; theme?: string } };
    return data.settings ?? {};
  } catch {
    return {};
  }
}

const saved = savedSettings();
let lang: Lang = saved.language === 'en' ? 'en' : 'es';
let theme: Theme = saved.theme === 'light' || saved.theme === 'dark' ? saved.theme : 'system';
// The window, menu and native controls follow the theme chosen in the app.
nativeTheme.themeSource = theme;

/** Native menu and dialog texts in each UI language. */
const TEXT = {
  es: {
    file: 'Archivo', newRun: 'Nuevo registro', refreshJira: 'Actualizar tickets de Jira', view: 'Ver',
    dashboard: 'Dashboard', runs: 'Registros', team: 'Equipo', config: 'Tipos y ajustes', search: 'Buscar registros',
    resetZoom: 'Tamaño real', zoomIn: 'Acercar', zoomOut: 'Alejar', fullscreen: 'Pantalla completa',
    appearance: 'Apariencia', themeNames: { system: 'Automática', light: 'Clara', dark: 'Oscura' } as Record<Theme, string>,
    assistant: 'Asistente de Claude',
    portBusy: (port: number) => `El puerto ${port} está ocupado por otro programa. Ciérralo o abre la app con QA_DASH_PORT=8770.`,
    startFailed: 'No se pudo iniciar la app:',
    help: 'Ayuda', checkUpdates: 'Buscar actualizaciones…', showLog: 'Mostrar el log de la app', openData: 'Abrir la carpeta de datos', openDemo: 'Abrir demo (datos de ejemplo)', demoTitle: `${APP_NAME} · Demo`, demoFailed: 'No se pudo abrir la demo:',
  },
  en: {
    file: 'File', newRun: 'New run', refreshJira: 'Refresh Jira tickets', view: 'View',
    dashboard: 'Dashboard', runs: 'Runs', team: 'Team', config: 'Types & settings', search: 'Search runs',
    resetZoom: 'Actual size', zoomIn: 'Zoom in', zoomOut: 'Zoom out', fullscreen: 'Full screen',
    appearance: 'Appearance', themeNames: { system: 'Automatic', light: 'Light', dark: 'Dark' } as Record<Theme, string>,
    assistant: 'Claude assistant',
    portBusy: (port: number) => `Port ${port} is used by another program. Close it or open the app with QA_DASH_PORT=8770.`,
    startFailed: 'The app could not start:',
    help: 'Help', checkUpdates: 'Check for updates…', showLog: 'Show the app log', openData: 'Open the data folder', openDemo: 'Open demo (sample data)', demoTitle: `${APP_NAME} · Demo`, demoFailed: 'The demo could not open:',
  },
};

app.setName(APP_NAME);
// Date pickers and system texts in the app language.
app.commandLine.appendSwitch('lang', lang === 'en' ? 'en-US' : 'es-ES');
// The Chromium cache goes in a subfolder so it does not mix with qa-tests.json.
app.setPath('sessionData', path.join(defaultDataDir(), 'electron'));

/** Is another app instance (e.g. `npm start`) already serving the UI on that port? */
async function existingAppServes(): Promise<boolean> {
  try {
    const [page, api] = await Promise.all([fetch(URL_), fetch(`${URL_}/api/state`)]);
    return page.ok && (page.headers.get('content-type') ?? '').includes('text/html') && api.ok;
  } catch {
    return false;
  }
}

/** Starts the server or reuses one already running (two servers on the same file would overwrite each other). */
async function ensureServer(): Promise<void> {
  try {
    await startServer({ port: PORT, dataDir: defaultDataDir(), clientDir: path.join(app.getAppPath(), 'dist/client') });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && (await existingAppServes())) return;
    throw err;
  }
}

/** Demo on its own server (port 8790, sample data in a temp folder); created only once per session. */
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
        // `npm run demo` is already serving it: reuse it.
        const serving = await fetch(`${url}/api/state`).then((r) => r.ok, () => false);
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || !serving) throw err;
      }
      demoUrl = url;
    }
    createWindow(demoUrl, true);
  } catch (err) {
    log.error('demo.failed', err);
    dialog.showErrorBox(APP_NAME, `${TEXT[lang].demoFailed}\n${String(err)}`);
  }
}

interface WindowState { x?: number; y?: number; width: number; height: number; maximized?: boolean }

/** Size and position from the last session, so the window opens where you left it. */
function loadWindowState(): WindowState {
  try {
    const saved = JSON.parse(readFileSync(WINDOW_FILE, 'utf8')) as WindowState;
    if (saved.width >= 900 && saved.height >= 600) return saved;
  } catch {
    // First launch or corrupted file: use the default size.
  }
  return { width: 1320, height: 880 };
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const state: WindowState = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    mkdirSync(path.dirname(WINDOW_FILE), { recursive: true });
    writeFileSync(WINDOW_FILE, JSON.stringify(state));
  } catch {
    // Failing to save the position must not prevent the app from closing.
  }
}

/** Sends a menu command to the UI (new run, switch view, refresh Jira…). */
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
        { label: t.team, accelerator: 'CmdOrCtrl+4', click: () => sendCommand('tab:team') },
        { label: t.search, accelerator: 'CmdOrCtrl+F', click: () => sendCommand('search') },
        { label: t.assistant, accelerator: 'CmdOrCtrl+K', click: () => sendCommand('assistant') },
        { type: 'separator' },
        { role: 'resetZoom', label: t.resetZoom },
        { role: 'zoomIn', label: t.zoomIn },
        { role: 'zoomOut', label: t.zoomOut },
        { type: 'separator' },
        {
          label: t.appearance,
          submenu: (['system', 'light', 'dark'] as const).map((value) => ({
            label: t.themeNames[value],
            type: 'radio' as const,
            checked: theme === value,
            click: () => sendCommand(`theme:${value}`),
          })),
        },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t.fullscreen },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      label: t.help,
      submenu: [
        { label: t.checkUpdates, click: () => sendCommand('check-updates') },
        { type: 'separator' },
        { label: t.showLog, click: () => shell.showItemInFolder(log.file) },
        { label: t.openData, click: () => void shell.openPath(defaultDataDir()) },
        { type: 'separator' },
        { label: t.openDemo, click: () => void openDemo() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(url = URL_, demo = false): void {
  // The demo opens in a separate window and does not touch the main window's saved position.
  const saved = demo ? { width: 1320, height: 880 } : loadWindowState();
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    ...saved,
    minWidth: 900,
    minHeight: 600,
    title: demo ? TEXT[lang].demoTitle : APP_NAME,
    show: false,
    // Integrated title bar: the macOS traffic lights sit over the app header.
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 20 },
    // Same background as the app so there is no white flash when opening in dark mode.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#12151b' : '#f4f5f7',
    icon: path.join(app.getAppPath(), 'build/icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  if (saved.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  if (!demo) win.on('close', () => saveWindowState(win));

  // External links (Jira tickets) open in the browser, not inside the app.
  // Same origin, not a prefix: "http://127.0.0.1:8765@evil.example" starts with the app URL but is another site.
  const origin = (target: string): string | null => {
    try {
      return new URL(target).origin;
    } catch {
      return null;
    }
  };
  const isInternal = (target: string) => origin(target) === origin(url);
  // Only web links go to the system browser; other schemes (file:, custom app handlers) are ignored.
  const openOutside = (target: string): void => {
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
  };
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!isInternal(target)) openOutside(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (!isInternal(target)) {
      event.preventDefault();
      openOutside(target);
    }
  });

  void win.loadURL(url);

  // When the UI language or theme changes (the page's lang and data-theme attributes), rebuild the menu.
  // Only the main window drives this: the demo has its own settings.
  if (demo) return;
  const timer = setInterval(() => {
    if (win.isDestroyed()) return;
    win.webContents
      .executeJavaScript('[document.documentElement.lang, document.documentElement.dataset.theme || "system"]')
      .then((value: unknown) => {
        const [pageLang, pageTheme] = Array.isArray(value) ? value : [];
        let changed = false;
        if ((pageLang === 'es' || pageLang === 'en') && pageLang !== lang) {
          lang = pageLang;
          changed = true;
        }
        if ((pageTheme === 'system' || pageTheme === 'light' || pageTheme === 'dark') && pageTheme !== theme) {
          theme = pageTheme;
          nativeTheme.themeSource = theme;
          changed = true;
        }
        if (changed) buildMenu();
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
  app.on('will-quit', () => log.info('app.quit'));
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app
    .whenReady()
    .then(() => {
      buildMenu();
      // In development the Dock would otherwise show the Electron icon.
      if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(app.getAppPath(), 'build/icon.png'));
    })
    .then(ensureServer)
    .then(() => (process.argv.includes('--demo') ? openDemo() : createWindow()))
    .catch((err: unknown) => {
      const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
      log.error('app.start-failed', err, { port: PORT });
      dialog.showErrorBox(
        APP_NAME,
        busy
          ? TEXT[lang].portBusy(PORT)
          : `${TEXT[lang].startFailed}\n${String(err)}`,
      );
      app.quit();
    });
}
