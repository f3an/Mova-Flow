import express, { Request, Response } from 'express';
import multer from 'multer';
import * as os from 'os';
import * as fs from 'fs';
import { addClientHistoryEntry } from './clientHistory';

// A tiny, always-127.0.0.1-only server so other things running on this same
// Mac — right now just the browser extension (mova-flow-meet-recorder) —
// can hand off a finished recording to land in the same client-history.json
// the app's own Upload tab writes to, without needing IPC (the extension is
// a separate process, in the browser, not part of this Electron app).
export const EXTENSION_BRIDGE_PORT = 5057;

export function startExtensionBridge(userDataDir: string): void {
  const app = express();
  const upload = multer({ dest: os.tmpdir() });

  app.post('/extension/history', upload.single('file'), (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file in the request.' });
      return;
    }
    const { filename, language, text } = req.body as { filename?: string; language?: string; text?: string };
    if (!filename || typeof text !== 'string') {
      fs.unlink(req.file.path, () => {});
      res.status(400).json({ error: 'Missing filename or text.' });
      return;
    }

    const audioBytes = fs.readFileSync(req.file.path);
    fs.unlink(req.file.path, () => {});
    addClientHistoryEntry(userDataDir, filename, language || 'auto', '.wav', audioBytes, text);
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
