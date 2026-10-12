import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import * as os from 'os';
import * as fs from 'fs';
import {
  addClientHistoryEntry,
  deleteClientHistoryEntry,
  getClientHistory,
  getClientHistoryText,
} from './clientHistory';
import { addFinishedRecording, deleteRecording, listRecordings } from './recordings';
import { deleteHostHistoryEntry, getHostHistory, getHostHistoryText } from './server';

// A tiny, always-127.0.0.1-only server so other things running on this same
// Mac — right now just the browser extension (mova-flow-meet-recorder) —
// can hand recordings to the app without IPC (the extension is a separate
// process, in the browser, not part of this Electron app):
//
//   POST /extension/recording  the WAV, as soon as the meeting is stopped and
//                              before it's sent to the host: it waits in
//                              History as "Not transcribed" until then, so a
//                              failed upload loses nothing (see recordings.ts)
//   POST /extension/history    the finished transcript — lands in the same
//                              client-history.json the app's Upload tab
//                              writes to; with recording_id, that waiting
//                              recording is done and goes away
//   GET /extension/history     the app's History, exactly as its History tab
//                              shows it (the host's list on a host, the
//                              client's own on a client), plus recordings
//                              still waiting for a transcript — so the
//                              extension's side panel shows the same list
//   GET /extension/history/:id/text, DELETE /extension/history/:id
//   POST /extension/recording with transcribe=1, or
//   POST /extension/transcribe/:id
//                              the app transcribes the recording itself —
//                              through its own host connection, into its own
//                              History — and GET /extension/jobs/:id reports
//                              how it's going; the extension needs no host
//                              settings of its own
//   GET /extension/status      the app's version and where it transcribes
//
// Reading transcripts is limited to Mova Flow's own extension (see
// trustedExtensionsOnly); handing recordings in stays open to any extension.
export const EXTENSION_BRIDGE_PORT = 5057;

/** Mova Flow Meet Recorder on the Chrome Web Store (Brave installs the same ID). */
const STORE_EXTENSION_ID = 'kdeeohghjiengnkgfpjkakeajhnddfnh';

export interface ExtensionJob {
  stage: 'processing' | 'done' | 'error';
  message?: string;
  text?: string;
  language?: string;
  updatedAt: number;
}

export interface AppStatus {
  version: string;
  role: 'host' | 'client';
  /** The host a client sends to; null on a host. */
  host: string | null;
  serverStage: string;
}

export interface BridgeOptions {
  /** Which History the app shows: the host's own, or this client's. */
  role(): 'host' | 'client';
  /** Extra extension IDs allowed to read History — an unpacked build has an
   * ID of its own (config.json → trusted_extension_ids). */
  trustedExtensionIds(): string[];
  /** Hands a saved recording to the app's own transcription (the renderer). */
  transcribe(id: string, name: string, language?: string): void;
  job(id: string): ExtensionJob | null;
  status(): AppStatus;
}

const PREVIEW_CHARS = 240;

// An hour of 16 kHz stereo is ~230 MB; leave room for long meetings.
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** Only extensions: any web page can send a request to 127.0.0.1, but it
 * can't fake the Origin header the browser stamps on it. */
function extensionsOnly(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('origin') || '';
  if (!/^(chrome|moz)-extension:\/\//.test(origin)) {
    res.status(403).json({ error: 'Not allowed.' });
    return;
  }
  next();
}

function extensionId(req: Request): string | null {
  return (req.get('origin') || '').match(/^chrome-extension:\/\/([a-p]{32})$/)?.[1] ?? null;
}

export function startExtensionBridge(userDataDir: string, options: BridgeOptions): void {
  const app = express();

  // The extension reaches this over plain CORS — it has no host permission
  // for 127.0.0.1 any more, since with one Chrome leaves the Origin header off
  // its GETs, and Origin is what tells Mova Flow's own extension apart below.
  // Any extension may read the responses (the routes themselves turn away the
  // ones they shouldn't serve, with a 403 the extension can then read);
  // web pages get no CORS headers, so their browser never shows them a thing.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.get('origin') || '';
    if (/^(chrome|moz)-extension:\/\//.test(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        // Chrome's Private Network Access preflight, for builds that still send it.
        if (req.get('access-control-request-private-network')) res.header('Access-Control-Allow-Private-Network', 'true');
        res.header('Access-Control-Max-Age', '600');
        res.sendStatus(204);
        return;
      }
    }
    next();
  });

  // Transcripts are private: any extension could POST a recording here, but
  // only Mova Flow's own may read the History back or use the host.
  const isTrusted = (req: Request): boolean => {
    const id = extensionId(req);
    return !!id && (id === STORE_EXTENSION_ID || options.trustedExtensionIds().includes(id));
  };
  const trustedExtensionsOnly = (req: Request, res: Response, next: NextFunction): void => {
    if (!isTrusted(req)) {
      res.status(403).json({ error: 'Not allowed.' });
      return;
    }
    next();
  };

  const isHost = () => options.role() === 'host';
  const textOf = (id: string) => (isHost() ? getHostHistoryText(userDataDir, id) : getClientHistoryText(userDataDir, id));

  app.get('/extension/history', trustedExtensionsOnly, (_req: Request, res: Response) => {
    const entries = isHost() ? getHostHistory(userDataDir) : getClientHistory(userDataDir);
    res.json({
      source: isHost() ? 'host' : 'client',
      items: entries.map((e) => ({
        id: e.id,
        filename: e.filename,
        language: e.language,
        createdAt: e.createdAt,
        preview: (textOf(e.id) ?? '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS),
      })),
      pending: listRecordings(userDataDir).map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.createdAt,
        seconds: r.seconds,
        recording: r.state === 'recording',
      })),
    });
  });

  app.get('/extension/history/:id/text', trustedExtensionsOnly, (req: Request<{ id: string }>, res: Response) => {
    const text = textOf(req.params.id);
    if (text === null) {
      res.status(404).json({ error: 'Transcript not found.' });
      return;
    }
    res.json({ text });
  });

  app.post('/extension/transcribe/:id', trustedExtensionsOnly, express.json(), (req: Request<{ id: string }>, res: Response) => {
    const pending = listRecordings(userDataDir).find((r) => r.id === req.params.id && r.state === 'ready');
    if (!pending) {
      res.status(404).json({ error: 'Recording not found.' });
      return;
    }
    const language = (req.body as { language?: unknown } | undefined)?.language;
    options.transcribe(pending.id, pending.name, typeof language === 'string' ? language : undefined);
    res.json({ ok: true });
  });

  app.get('/extension/jobs/:id', trustedExtensionsOnly, (req: Request<{ id: string }>, res: Response) => {
    const job = options.job(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'No such job.' });
      return;
    }
    res.json(job);
  });

  app.get('/extension/status', trustedExtensionsOnly, (_req: Request, res: Response) => {
    res.json(options.status());
  });

  app.delete('/extension/history/:id', trustedExtensionsOnly, (req: Request<{ id: string }>, res: Response) => {
    const ok = isHost()
      ? deleteHostHistoryEntry(userDataDir, req.params.id)
      : deleteClientHistoryEntry(userDataDir, req.params.id);
    res.status(ok ? 200 : 404).json({ ok });
  });
  const upload = multer({ dest: os.tmpdir(), limits: { fileSize: MAX_UPLOAD_BYTES } });

  app.post('/extension/recording', extensionsOnly, upload.single('file'), (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file in the request.' });
      return;
    }
    const { filename, speaker_timeline, transcribe, language } = req.body as {
      filename?: string;
      speaker_timeline?: string;
      transcribe?: string;
      language?: string;
    };
    try {
      const name = filename || 'Meet.wav';
      const id = addFinishedRecording(
        userDataDir,
        name,
        fs.readFileSync(req.file.path),
        typeof speaker_timeline === 'string' ? speaker_timeline : undefined,
      );
      if (transcribe === '1' && isTrusted(req)) options.transcribe(id, name, typeof language === 'string' ? language : undefined);
      res.json({ id });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    } finally {
      fs.unlink(req.file.path, () => {});
    }
  });

  app.post('/extension/history', extensionsOnly, upload.single('file'), (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file in the request.' });
      return;
    }
    const { filename, language, text, recording_id } = req.body as {
      filename?: string;
      language?: string;
      text?: string;
      recording_id?: string;
    };
    if (!filename || typeof text !== 'string') {
      fs.unlink(req.file.path, () => {});
      res.status(400).json({ error: 'Missing filename or text.' });
      return;
    }

    const audioBytes = fs.readFileSync(req.file.path);
    fs.unlink(req.file.path, () => {});
    addClientHistoryEntry(userDataDir, filename, language || 'auto', '.wav', audioBytes, text);
    if (recording_id) deleteRecording(userDataDir, recording_id);
    res.json({ ok: true });
  });

  const server = app.listen(EXTENSION_BRIDGE_PORT, '127.0.0.1');
  server.on('error', (err) => {
    // Most likely another Mova Flow instance already has this port — the
    // extension bridge is a nice-to-have, not core functionality, so this
    // must never take the rest of the app down with it.
    console.error('[extension bridge] failed to start:', err);
  });
}
