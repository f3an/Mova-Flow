import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import type { Server } from 'http';
import type { Socket } from 'net';
import { randomUUID } from 'crypto';
import { transcribe } from './engine';
import { issueToken, timingSafeEqualStr, verifyToken } from './auth';
import { rateLimiter } from './rateLimit';

// whisper-cli decodes audio via miniaudio, which only supports these formats
// directly ("supported audio formats" in `whisper-cli --help`). Everything else
// (m4a, mov, ...) gets converted to WAV in the browser (Web Audio API) by
// renderer.ts before it's ever sent here.
const ALLOWED_EXT = new Set(['.mp3', '.wav', '.ogg', '.flac']);

const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};

interface Job {
  status: 'queued' | 'processing' | 'done' | 'error';
  progress: string;
  filename: string;
  result?: string;
  outputFile?: string;
  detectedLanguage?: string;
  error?: string;
}

// One entry per completed transcription, kept on disk (history.json) so the
// list — and the original audio, kept alongside instead of deleted — survives
// server restarts, unlike the in-memory `jobs` map above.
interface HistoryEntry {
  id: string;
  filename: string;
  language: string;
  createdAt: number;
  audioExt: string;
}

function historyPath(userDataDir: string): string {
  return path.join(userDataDir, 'history.json');
}

function loadHistory(userDataDir: string): HistoryEntry[] {
  try {
    return JSON.parse(fs.readFileSync(historyPath(userDataDir), 'utf-8'));
  } catch {
    return [];
  }
}

function saveHistory(userDataDir: string, entries: HistoryEntry[]): void {
  fs.writeFileSync(historyPath(userDataDir), JSON.stringify(entries, null, 2), 'utf-8');
}

const jobs = new Map<string, Job>();

function runJob(
  jobId: string,
  filePath: string,
  originalname: string,
  language: string,
  userDataDir: string,
  modelFilePath: string,
  outputDir: string,
  audioDir: string,
): void {
  const job = jobs.get(jobId)!;
  job.status = 'processing';
  job.progress = 'Transcribing audio... this can take a few minutes.';

  transcribe(userDataDir, modelFilePath, filePath, language, (progress) => {
    const j = jobs.get(jobId);
    if (j) j.progress = progress;
  })
    .then((result) => {
      const outputFile = `${jobId}.txt`;
      fs.writeFileSync(path.join(outputDir, outputFile), result.text, 'utf-8');

      const ext = path.extname(originalname).toLowerCase();
      fs.renameSync(filePath, path.join(audioDir, `${jobId}${ext}`));

      const history = loadHistory(userDataDir);
      history.unshift({
        id: jobId,
        filename: originalname,
        language: result.detectedLanguage,
        createdAt: Date.now(),
        audioExt: ext,
      });
      saveHistory(userDataDir, history);

      const j = jobs.get(jobId)!;
      j.status = 'done';
      j.result = result.text;
      j.outputFile = outputFile;
      j.detectedLanguage = result.detectedLanguage;
      j.progress = 'Done.';
    })
    .catch((err: Error) => {
      const j = jobs.get(jobId);
      if (j) {
        j.status = 'error';
        j.error = err.message;
      }
      fs.unlink(filePath, () => {});
    });
}

/** Managed (start/stop) HTTP server — the equivalent of werkzeug's make_server
 * in the Python version. Keeps its own socket registry so stop() can force-close
 * keep-alive connections instead of waiting on a graceful close() that could hang. */
export class ServerController {
  private httpServer: Server | null = null;
  private sockets = new Set<Socket>();

  isRunning(): boolean {
    return this.httpServer !== null;
  }

  /** `getSecret` is a getter, not a value: the secret can be regenerated while
   * the server is running, so token verification must always see the current one. */
  start(
    port: number,
    userDataDir: string,
    modelFilePath: string,
    lanExpose: boolean,
    getSecret: () => string,
  ): Promise<void> {
    if (this.httpServer) return Promise.resolve();

    const uploadDir = path.join(userDataDir, 'uploads');
    const outputDir = path.join(userDataDir, 'transcripts');
    const audioDir = path.join(userDataDir, 'audio');
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(audioDir, { recursive: true });

    const app = express();
    app.use(express.json());

    // The renderer always loads locally (file://), so fetch() to /api/... is
    // always cross-origin — without this header Electron would just block the
    // requests. The Authorization header and the application/json body force the
    // browser into a preflight (OPTIONS), so that has to be served explicitly too.
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
    });

    app.get('/', (_req, res) => res.json({ ok: true }));

    // A cheap general limiter on all of /api, plus a stricter one specifically on
    // /api/auth to slow down secret brute-forcing.
    app.use('/api', rateLimiter(5 * 60 * 1000, 120));

    app.post('/api/auth', rateLimiter(60 * 1000, 5), (req: Request, res: Response) => {
      const secret = typeof req.body?.secret === 'string' ? req.body.secret : '';
      if (!secret || !timingSafeEqualStr(secret, getSecret())) {
        res.status(401).json({ error: 'Invalid secret key.' });
        return;
      }
      const { token, expiresAt } = issueToken(getSecret());
      res.json({ token, expiresAt });
    });

    const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
      if (!token || !verifyToken(token, getSecret())) {
        res.status(401).json({ error: 'Authorization required.' });
        return;
      }
      next();
    };

    const upload = multer({ dest: uploadDir });

    app.post('/api/transcribe', requireAuth, upload.single('file'), (req: Request, res: Response) => {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'No file found in the request' });
        return;
      }
      const ext = path.extname(file.originalname).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        fs.unlink(file.path, () => {});
        res.status(400).json({
          error: `Unsupported format: ${ext}. Allowed: ${[...ALLOWED_EXT].sort().join(', ')}`,
        });
        return;
      }

      const language = (req.body.language as string) || 'auto';
      const jobId = randomUUID().replace(/-/g, '').slice(0, 12);
      jobs.set(jobId, { status: 'queued', progress: 'Queued...', filename: file.originalname });
      runJob(jobId, file.path, file.originalname, language, userDataDir, modelFilePath, outputDir, audioDir);

      res.json({ job_id: jobId });
    });

    app.get('/api/status/:id', requireAuth, (req: Request<{ id: string }>, res: Response) => {
      const job = jobs.get(req.params.id);
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      const { result, ...rest } = job;
      res.json(job.status === 'done' ? { ...rest, result } : rest);
    });

    // Reads straight off disk rather than the in-memory `jobs` map, so history
    // entries from a previous server run (jobs map reset on restart) still work.
    const idParamSafe = (id: string): boolean => /^[a-f0-9]{1,32}$/.test(id);

    app.get('/api/download/:id', requireAuth, (req: Request<{ id: string }>, res: Response) => {
      const { id } = req.params;
      if (!idParamSafe(id) || !fs.existsSync(path.join(outputDir, `${id}.txt`))) {
        res.status(404).json({ error: 'Transcript not ready yet' });
        return;
      }
      res.download(path.join(outputDir, `${id}.txt`), `transcript_${id}.txt`);
    });

    app.get('/api/history', requireAuth, (_req: Request, res: Response) => {
      res.json({ items: loadHistory(userDataDir) });
    });

    app.get('/api/history/:id/text', requireAuth, (req: Request<{ id: string }>, res: Response) => {
      const { id } = req.params;
      const textFile = path.join(outputDir, `${id}.txt`);
      if (!idParamSafe(id) || !fs.existsSync(textFile)) {
        res.status(404).json({ error: 'Transcript not found' });
        return;
      }
      res.json({ text: fs.readFileSync(textFile, 'utf-8') });
    });

    app.get('/api/history/:id/audio', requireAuth, (req: Request<{ id: string }>, res: Response) => {
      const { id } = req.params;
      const entry = loadHistory(userDataDir).find((e) => e.id === id);
      if (!idParamSafe(id) || !entry) {
        res.status(404).json({ error: 'Recording not found' });
        return;
      }
      const audioFile = path.join(audioDir, `${id}${entry.audioExt}`);
      if (!fs.existsSync(audioFile)) {
        res.status(404).json({ error: 'Recording not found' });
        return;
      }
      res.type(AUDIO_MIME[entry.audioExt] || 'application/octet-stream');
      res.sendFile(audioFile);
    });

    app.delete('/api/history/:id', requireAuth, (req: Request<{ id: string }>, res: Response) => {
      const { id } = req.params;
      if (!idParamSafe(id)) {
        res.status(404).json({ error: 'Recording not found' });
        return;
      }
      const history = loadHistory(userDataDir);
      const entry = history.find((e) => e.id === id);
      if (!entry) {
        res.status(404).json({ error: 'Recording not found' });
        return;
      }
      saveHistory(userDataDir, history.filter((e) => e.id !== id));
      fs.unlink(path.join(audioDir, `${id}${entry.audioExt}`), () => {});
      fs.unlink(path.join(outputDir, `${id}.txt`), () => {});
      res.json({ ok: true });
    });

    return new Promise((resolve, reject) => {
      const srv = app.listen(port, lanExpose ? '0.0.0.0' : '127.0.0.1', () => {
        this.httpServer = srv;
        resolve();
      });
      srv.on('connection', (socket: Socket) => {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
      });
      srv.on('error', reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.httpServer) {
        resolve();
        return;
      }
      const srv = this.httpServer;
      this.httpServer = null;
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      srv.close(() => resolve());
    });
  }
}

export const controller = new ServerController();
