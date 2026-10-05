import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import * as os from 'os';
import * as fs from 'fs';
import { addClientHistoryEntry } from './clientHistory';
import { addFinishedRecording, deleteRecording } from './recordings';

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
export const EXTENSION_BRIDGE_PORT = 5057;

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

export function startExtensionBridge(userDataDir: string): void {
  const app = express();
  const upload = multer({ dest: os.tmpdir(), limits: { fileSize: MAX_UPLOAD_BYTES } });

  app.post('/extension/recording', extensionsOnly, upload.single('file'), (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file in the request.' });
      return;
    }
    const { filename, speaker_timeline } = req.body as { filename?: string; speaker_timeline?: string };
    try {
      const id = addFinishedRecording(
        userDataDir,
        filename || 'Meet.wav',
        fs.readFileSync(req.file.path),
        typeof speaker_timeline === 'string' ? speaker_timeline : undefined,
      );
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
