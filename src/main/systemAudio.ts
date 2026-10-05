import { app, BrowserWindow, desktopCapturer, session, systemPreferences } from 'electron';
import { execFile, spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// "Record a call" needs what the computer *plays* (the other side of a Zoom,
// Teams, Telegram… call) next to the microphone the renderer records itself.
//
// - Windows: Electron captures system audio on its own — getDisplayMedia in
//   the renderer, answered here with audio: 'loopback'.
// - macOS: Electron's loopback is Windows-only, so a small bundled helper
//   (native/macos/audio-tap, a Core Audio process tap) records it to a WAV
//   file instead. macOS asks once for "System Audio Recording" — no screen
//   recording permission involved.

/** Registered once at startup: lets the renderer's getDisplayMedia() return
 * the system audio on Windows without showing a screen picker. The video
 * track that comes with it is stopped by the renderer straight away. */
export function initSystemAudioCapture(): void {
  if (process.platform !== 'win32') return;
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const [screen] = await desktopCapturer.getSources({ types: ['screen'] });
    callback(screen ? { video: screen, audio: 'loopback' } : {});
  });
}

/** macOS asks for the microphone per app; ask up front so the first
 * recording doesn't silently come back without the user's side. */
export async function ensureMicrophoneAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
  return systemPreferences.askForMediaAccess('microphone');
}

function helperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'mova-audio-tap')
    : // dist/main/ → the repo's build/bin, where `npm run build:native` puts it.
      path.join(__dirname, '..', '..', 'build', 'bin', 'mova-audio-tap');
}

/** Process taps exist since macOS 14.2 (Darwin 23.2). */
function macSupportsTaps(): boolean {
  const [major, minor] = os.release().split('.').map(Number);
  return major > 23 || (major === 23 && minor >= 2);
}

export interface AudioApp {
  bundleId: string;
  name: string;
  /** Producing sound right now. */
  playing: boolean;
  /** base64 PNG, 64 px. */
  icon?: string;
  /** The app's windows, largest first — desktopCapturer's "window:<id>:0". */
  windowIds: number[];
}

/** One card in the "what to record" picker. */
export interface CaptureSource {
  bundleId: string;
  name: string;
  playing: boolean;
  /** data: URLs. The thumbnail is missing without Screen Recording access. */
  icon?: string;
  thumbnail?: string;
}

/** Apps that currently have audio streams, for picking what to record
 * (macOS only — Windows loopback can only take the whole system mix). */
export function listMacAudioApps(): Promise<AudioApp[]> {
  if (process.platform !== 'darwin' || !macSupportsTaps() || !fs.existsSync(helperPath())) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(helperPath(), ['list'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const apps = JSON.parse(stdout) as AudioApp[];
        // Never offer recording Mova Flow itself.
        resolve(apps.filter((a) => a.bundleId !== 'com.movaflow.app'));
      } catch {
        resolve([]);
      }
    });
  });
}

let tap: { child: ChildProcessWithoutNullStreams; file: string; stopped: Promise<void> } | null = null;

/** Apps with audio, each with a thumbnail of its largest window. Thumbnails
 * need the Screen Recording permission on macOS — asked for once, the first
 * time; nothing is recorded with it, it only renders these previews. Without
 * it the picker falls back to app icons and recording works the same. */
export async function listCaptureSources(): Promise<CaptureSource[]> {
  const apps = await listMacAudioApps();
  if (!apps.length) return [];

  const thumbnails = new Map<number, string>();
  if (systemPreferences.getMediaAccessStatus('screen') !== 'denied') {
    try {
      const windows = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 480, height: 300 } });
      for (const win of windows) {
        const id = Number(win.id.split(':')[1]);
        if (!win.thumbnail.isEmpty()) thumbnails.set(id, win.thumbnail.toDataURL());
      }
    } catch {
      /* no access — icons only */
    }
  }

  return apps.map((app) => ({
    bundleId: app.bundleId,
    name: app.name,
    playing: app.playing,
    icon: app.icon ? `data:image/png;base64,${app.icon}` : undefined,
    thumbnail: app.windowIds.map((id) => thumbnails.get(id)).find(Boolean),
  }));
}

/** Starts the macOS helper — everything the system plays, or only `appBundleId`
 * — resolving with the epoch-ms the recording started; its level readings are
 * forwarded to `win` as 'system-audio-level'. */
export function startMacSystemAudio(win: BrowserWindow, appBundleId?: string): Promise<{ startedAt: number }> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('macOS only'));
  if (tap) return Promise.reject(new Error('Already recording.'));
  if (!macSupportsTaps()) {
    return Promise.reject(new Error('Recording system audio needs macOS 14.2 or newer.'));
  }
  const exe = helperPath();
  if (!fs.existsSync(exe)) return Promise.reject(new Error(`Audio capture helper is missing (${exe}).`));

  const file = path.join(app.getPath('temp'), `mova-flow-system-${Date.now()}.wav`);
  const child = spawn(exe, appBundleId ? [file, '--app', appBundleId] : [file]);
  let settled = false;

  return new Promise((resolve, reject) => {
    let buffered = '';
    const stopped = new Promise<void>((done) => child.on('exit', () => done()));
    tap = { child, file, stopped };

    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf-8');
      let idx: number;
      while ((idx = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, idx);
        buffered = buffered.slice(idx + 1);
        let msg: { event?: string; at?: number; level?: number; message?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof msg.level === 'number') {
          if (!win.isDestroyed()) win.webContents.send('system-audio-level', msg.level);
        } else if (msg.event === 'started' && !settled) {
          settled = true;
          resolve({ startedAt: msg.at ?? Date.now() });
        } else if (msg.event === 'error' && !settled) {
          settled = true;
          reject(new Error(msg.message || 'System audio capture failed.'));
        }
      }
    });
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on('exit', () => {
      if (!settled) {
        settled = true;
        reject(new Error('System audio capture stopped unexpectedly.'));
      }
    });
  }).catch((err) => {
    tap = null;
    fs.rmSync(file, { force: true });
    throw err;
  }) as Promise<{ startedAt: number }>;
}

/** Stops the helper and returns the recorded 16 kHz mono WAV, or null if
 * nothing was recording. The temp file is removed afterwards. */
export async function stopMacSystemAudio(): Promise<Buffer | null> {
  const current = tap;
  if (!current) return null;
  tap = null;
  current.child.stdin.end(); // the helper stops on stdin EOF
  const killTimer = setTimeout(() => current.child.kill('SIGTERM'), 5000);
  await current.stopped;
  clearTimeout(killTimer);
  try {
    return fs.readFileSync(current.file);
  } catch {
    return null;
  } finally {
    fs.rmSync(current.file, { force: true });
  }
}

/** Quitting mid-recording must not leave the helper running. */
export function abortSystemAudio(): void {
  if (!tap) return;
  tap.child.kill('SIGTERM');
  fs.rmSync(tap.file, { force: true });
  tap = null;
}
