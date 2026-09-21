import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, IpcMainInvokeEvent, net } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { autoUpdater } from 'electron-updater';
import { controller } from './server';
import { startAdvertising, stopAdvertising, discoverHosts } from './discovery';
import { ensureEngine, modelPath, DEFAULT_MODEL_PRESET, ModelChoice, ModelPreset } from './engine';
import { generateSecret, issueToken } from './auth';
import {
  addClientHistoryEntry,
  deleteClientHistoryEntry,
  getClientHistory,
  getClientHistoryAudio,
  getClientHistoryText,
} from './clientHistory';
import { startExtensionBridge } from './localBridge';

type UiLang = 'en' | 'uk';

interface Config {
  role: 'host' | 'client';
  server_host: string;
  server_port: number;
  auth_secret: string;
  client_secret: string;
  language: UiLang;
  model_preset: ModelPreset;
  // Absolute path to a model file the user picked themselves. Non-empty means
  // "use this instead of downloading a preset" — see ModelChoice in engine.ts.
  model_path: string;
  // false binds the server to 127.0.0.1 only — this machine's own Upload tab
  // still works (it always talks to the host over localhost), but no other
  // device on the network can reach it.
  lan_expose: boolean;
}

const DEFAULT_CONFIG: Config = {
  role: 'host',
  server_host: '',
  server_port: 5000,
  auth_secret: '',
  client_secret: '',
  language: 'en',
  model_preset: DEFAULT_MODEL_PRESET,
  model_path: '',
  lan_expose: false,
};

function modelChoiceFromConfig(cfg: Config): ModelChoice {
  return { customPath: cfg.model_path, preset: cfg.model_preset };
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig(): Config {
  try {
    // Strip a possible leading BOM — our own writes never add one, but a
    // hand-edited config.json (e.g. saved by a text editor) might.
    const raw = fs.readFileSync(configPath(), 'utf-8').replace(/^﻿/, '');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(cfg: Config): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf-8');
}

function getLanIp(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// Captured before anything below has a chance to write config.json (e.g. the
// auth-secret bootstrap just below), so it reflects whether the user has
// actually been through setup — not just whether the app has run once.
const hadConfigAtLaunch = fs.existsSync(configPath());

// Kept in memory separate from disk so requireAuth doesn't do a synchronous
// config.json read on every HTTP request — this variable is what gets
// updated wherever the secret changes.
let authSecret: string = (() => {
  const cfg = readConfig();
  if (cfg.auth_secret) return cfg.auth_secret;
  const generated = generateSecret();
  writeConfig({ ...cfg, auth_secret: generated });
  return generated;
})();

type ServerStage = 'stopped' | 'checking' | 'installing' | 'starting' | 'running' | 'error';

interface ServerState {
  stage: ServerStage;
  message: string;
  port: number | null;
  error: string | null;
}

let serverState: ServerState = { stage: 'stopped', message: '', port: null, error: null };

function setServerState(patch: Partial<ServerState>): void {
  serverState = { ...serverState, ...patch };
}

type UpdateStage = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error';

interface UpdateState {
  stage: UpdateStage;
  version: string | null;
  error: string | null;
}

let updateState: UpdateState = { stage: 'idle', version: null, error: null };

function setUpdateState(patch: Partial<UpdateState>): void {
  updateState = { ...updateState, ...patch };
}

/** electron-updater reads app-update.yml, which electron-builder only writes
 * into a packaged build (see the `publish` block in package.json) — running
 * unpacked via `electron .` has no such file and would just throw. */
function initAutoUpdater(): void {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => setUpdateState({ stage: 'checking' }));
  autoUpdater.on('update-not-available', () => setUpdateState({ stage: 'not-available' }));
  autoUpdater.on('error', (err) => setUpdateState({ stage: 'error', error: err.message }));
  autoUpdater.on('download-progress', () => setUpdateState({ stage: 'downloading' }));
  autoUpdater.on('update-downloaded', (info) => setUpdateState({ stage: 'downloaded', version: info.version }));

  autoUpdater.on('update-available', (info) => {
    setUpdateState({ stage: 'available', version: info.version });
    void autoUpdater.downloadUpdate();
  });

  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
// Set by the tray's "Exit" item before any window actually closes, so the
// close handler below knows this is a real quit and not just the user
// clicking the titlebar's close button.
let isQuitting = false;

function showMainWindow(): void {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

// Clicking the titlebar close button hides the app to the tray instead of
// quitting it, same as most tray-resident apps — the server should keep
// running until the user explicitly chooses Exit. Same behavior on every
// platform (Tray works the same in the Windows/Linux tray and the macOS
// menu bar), so there's no OS check here.
function createTray(): void {
  tray = new Tray(path.join(__dirname, '..', '..', 'build', 'icons', '16x16.png'));
  tray.setToolTip('Mova Flow');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Mova Flow', click: showMainWindow },
      { type: 'separator' },
      {
        label: 'Open DevTools',
        click: () => mainWindow?.webContents.openDevTools({ mode: 'detach' }),
      },
      { type: 'separator' },
      { label: 'Exit', click: () => app.quit() },
    ]),
  );
  tray.on('click', showMainWindow);
}

function createWindow(): void {
  const win = new BrowserWindow({
    title: 'Mova Flow',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    width: 980,
    height: 720,
    minWidth: 560,
    minHeight: 420,
    maxWidth: 1200,
    // Paper background right away so there's no white flash before the CSS loads.
    backgroundColor: '#f3f1ea',
    autoHideMenuBar: true,
    // Windows Controls Overlay: the native minimize/maximize/close buttons stay
    // (OS-drawn), just wrapped in a custom titlebar instead of the stock white strip.
    // titleBarOverlay is Windows/Linux-only; on macOS `titleBarStyle: 'hidden'` alone
    // draws the traffic lights on top of the page instead — trafficLightPosition below
    // centers them in the same 36px-tall bar, and style.css reserves room for them.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#2c4235',
      symbolColor: '#e9e7dc',
      height: 36,
    },
    trafficLightPosition: { x: 14, y: 11 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    win.hide();
  });
  // No application menu (Menu.setApplicationMenu(null) below), so the usual
  // menu-role DevTools shortcut doesn't exist either — this reinstates it by
  // hand, plus the cross-platform F12, for exactly this kind of debugging.
  win.webContents.on('before-input-event', (_event, input) => {
    const isMacToggle = input.meta && input.alt && input.key.toLowerCase() === 'i';
    const isWinToggle = input.control && input.shift && input.key.toLowerCase() === 'i';
    if (input.key === 'F12' || isMacToggle || isWinToggle) {
      win.webContents.toggleDevTools();
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

async function startServer(): Promise<void> {
  if (serverState.stage !== 'stopped' && serverState.stage !== 'error') return;
  const cfg = readConfig();
  const port = cfg.server_port || 5000;
  const userDataDir = app.getPath('userData');
  const model = modelChoiceFromConfig(cfg);

  setServerState({ stage: 'checking', message: 'Checking recognition components...', error: null });
  try {
    await ensureEngine(userDataDir, model, (message) => setServerState({ stage: 'installing', message }));
    setServerState({ stage: 'starting', message: 'Starting server...' });
    await controller.start(port, userDataDir, modelPath(userDataDir, model), cfg.lan_expose, () => authSecret);
    if (cfg.lan_expose) startAdvertising(port);
    setServerState({ stage: 'running', message: 'Ready', port, error: null });
  } catch (err) {
    setServerState({ stage: 'error', message: '', error: (err as Error).message });
  }
}

ipcMain.handle('get-state', () => {
  const cfg = readConfig();
  return {
    role: cfg.role,
    host: cfg.server_host,
    port: cfg.server_port,
    lan_ip: getLanIp(),
    server: serverState,
    authSecret,
    clientSecret: cfg.client_secret,
    language: cfg.language,
    modelPreset: cfg.model_preset,
    modelPath: cfg.model_path,
    lanExpose: cfg.lan_expose,
    appVersion: app.getVersion(),
  };
});

ipcMain.handle(
  'save-config',
  (
    _evt: IpcMainInvokeEvent,
    role: 'host' | 'client',
    host: string,
    port: number,
    clientSecret: string,
    modelPreset: ModelPreset,
    modelCustomPath: string,
    lanExpose: boolean,
  ) => {
    const cfg = readConfig();
    writeConfig({
      ...cfg,
      role,
      server_host: (host || '').trim(),
      server_port: Number(port) || 5000,
      client_secret: (clientSecret || '').trim(),
      model_preset: modelPreset || cfg.model_preset,
      model_path: (modelCustomPath || '').trim(),
      lan_expose: !!lanExpose,
    });
    return { ok: true };
  },
);

ipcMain.handle('choose-model-file', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = win
    ? await dialog.showOpenDialog(win, {
        title: 'Choose a Whisper model file',
        filters: [{ name: 'GGML model', extensions: ['bin'] }],
        properties: ['openFile'],
      })
    : await dialog.showOpenDialog({
        title: 'Choose a Whisper model file',
        filters: [{ name: 'GGML model', extensions: ['bin'] }],
        properties: ['openFile'],
      });
  if (result.canceled || result.filePaths.length === 0) return { path: '' };
  return { path: result.filePaths[0] };
});

ipcMain.handle('set-language', (_evt: IpcMainInvokeEvent, lang: UiLang) => {
  writeConfig({ ...readConfig(), language: lang === 'uk' ? 'uk' : 'en' });
  return { ok: true };
});

ipcMain.handle('regenerate-secret', () => {
  authSecret = generateSecret();
  writeConfig({ ...readConfig(), auth_secret: authSecret });
  return { secret: authSecret };
});

ipcMain.handle('get-token', () => issueToken(authSecret));

ipcMain.handle('start-server', async () => {
  await startServer();
  return { ok: true };
});

ipcMain.handle('stop-server', async () => {
  await controller.stop();
  stopAdvertising();
  setServerState({ stage: 'stopped', message: '', port: null, error: null });
  return { ok: true };
});

ipcMain.handle(
  'check-remote',
  async (_evt: IpcMainInvokeEvent, host: string, port: number, secret: string) => {
    // net.fetch (Chromium's own network stack) instead of the global fetch
    // (Node/undici) — confirmed by testing that Node's fetch fails to reach
    // some LAN hosts that Chromium (the renderer, a real browser, this app's
    // own browser extension) connects to just fine from the same machine.
    // Most likely macOS's per-process Local Network permission not covering
    // Node's own networking the same way it covers Chromium's, but whatever
    // the exact cause, routing through Chromium's stack sidesteps it.
    try {
      const res = await net.fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { reachable: false, authOk: false, error: `HTTP ${res.status}` };

      const authRes = await net.fetch(`http://${host}:${port}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: secret || '' }),
        signal: AbortSignal.timeout(8000),
      });
      return { reachable: true, authOk: authRes.ok };
    } catch (err) {
      return { reachable: false, authOk: false, error: (err as Error).message || String(err) };
    }
  },
);

ipcMain.handle(
  'save-client-history-entry',
  (
    _evt: IpcMainInvokeEvent,
    filename: string,
    language: string,
    audioExt: string,
    audioBytes: ArrayBuffer,
    text: string,
  ) => {
    const entry = addClientHistoryEntry(
      app.getPath('userData'),
      filename,
      language,
      audioExt,
      Buffer.from(audioBytes),
      text,
    );
    return { entry };
  },
);

ipcMain.handle('get-client-history', () => ({
  items: getClientHistory(app.getPath('userData')),
}));

ipcMain.handle('get-client-history-text', (_evt: IpcMainInvokeEvent, id: string) => ({
  text: getClientHistoryText(app.getPath('userData'), id),
}));

ipcMain.handle('get-client-history-audio', (_evt: IpcMainInvokeEvent, id: string) => {
  const result = getClientHistoryAudio(app.getPath('userData'), id);
  return { data: result?.data ?? null, ext: result?.ext ?? null };
});

ipcMain.handle('delete-client-history-entry', (_evt: IpcMainInvokeEvent, id: string) => ({
  ok: deleteClientHistoryEntry(app.getPath('userData'), id),
}));

ipcMain.handle('get-update-state', () => updateState);

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall();
});

ipcMain.handle('check-for-updates', async () => {
  // electron-updater needs app-update.yml, which only exists in a packaged
  // build (see initAutoUpdater) — calling it unpacked would just throw.
  if (!app.isPackaged) return { ...updateState, stage: 'not-available' as UpdateStage };
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    setUpdateState({ stage: 'error', error: (err as Error).message });
  }
  // checkForUpdates()'s own event listeners (see initAutoUpdater) update
  // updateState synchronously as part of the same call, so it's already
  // fresh here — no need to wait for the renderer's next poll.
  return updateState;
});

ipcMain.handle('discover-hosts', async () => ({ hosts: await discoverHosts() }));

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  createTray();
  initAutoUpdater();
  startExtensionBridge(app.getPath('userData'));
  // Only auto-start on a machine that has already been set up (config.json
  // exists) — a fresh install must not silently kick off a multi-GB model
  // download before the user has even seen the Server tab and chosen a role.
  if (hadConfigAtLaunch && readConfig().role === 'host') void startServer();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Fires before any window's own 'close' event, on both a tray "Exit" click
// and macOS's Cmd+Q — marks this as a real quit so the close handler in
// createWindow() lets the window actually close instead of just hiding it.
app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  controller.stop();
  stopAdvertising();
  if (process.platform !== 'darwin') app.quit();
});
