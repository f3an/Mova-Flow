import { app, BrowserWindow, Menu, ipcMain, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { controller } from './server';
import { ensureEngine } from './engine';
import { generateSecret, issueToken } from './auth';

type UiLang = 'en' | 'uk';

interface Config {
  role: 'host' | 'client';
  server_host: string;
  server_port: number;
  auth_secret: string;
  client_secret: string;
  language: UiLang;
}

const DEFAULT_CONFIG: Config = {
  role: 'host',
  server_host: '',
  server_port: 5000,
  auth_secret: '',
  client_secret: '',
  language: 'en',
};

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

function createWindow(): void {
  const win = new BrowserWindow({
    title: 'Mova Flow',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    width: 980,
    height: 720,
    minWidth: 560,
    minHeight: 420,
    // Paper background right away so there's no white flash before the CSS loads.
    backgroundColor: '#f3f1ea',
    autoHideMenuBar: true,
    // Windows Controls Overlay: the native minimize/maximize/close buttons stay
    // (OS-drawn), just wrapped in a custom titlebar instead of the stock white strip.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#2c4235',
      symbolColor: '#e9e7dc',
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

async function startServer(): Promise<void> {
  if (serverState.stage !== 'stopped' && serverState.stage !== 'error') return;
  const cfg = readConfig();
  const port = cfg.server_port || 5000;
  const userDataDir = app.getPath('userData');

  setServerState({ stage: 'checking', message: 'Checking recognition components...', error: null });
  try {
    await ensureEngine(userDataDir, (message) => setServerState({ stage: 'installing', message }));
    setServerState({ stage: 'starting', message: 'Starting server...' });
    await controller.start(port, userDataDir, () => authSecret);
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
  };
});

ipcMain.handle(
  'save-config',
  (_evt: IpcMainInvokeEvent, role: 'host' | 'client', host: string, port: number, clientSecret: string) => {
    const cfg = readConfig();
    writeConfig({
      ...cfg,
      role,
      server_host: (host || '').trim(),
      server_port: Number(port) || 5000,
      client_secret: (clientSecret || '').trim(),
    });
    return { ok: true };
  },
);

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
  setServerState({ stage: 'stopped', message: '', port: null, error: null });
  return { ok: true };
});

ipcMain.handle(
  'check-remote',
  async (_evt: IpcMainInvokeEvent, host: string, port: number, secret: string) => {
    try {
      const res = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { reachable: false, authOk: false };

      const authRes = await fetch(`http://${host}:${port}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: secret || '' }),
        signal: AbortSignal.timeout(3000),
      });
      return { reachable: true, authOk: authRes.ok };
    } catch {
      return { reachable: false, authOk: false };
    }
  },
);

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  if (readConfig().role === 'host') void startServer();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  controller.stop();
  if (process.platform !== 'darwin') app.quit();
});
