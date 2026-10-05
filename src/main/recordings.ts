import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

// A call recording exists exactly once, so it goes to disk while it's being
// made, not when it's stopped: each recording is a folder in
// userData/recordings with
//
//   meta.json   name, state, when each side started
//   me.pcm      the microphone, raw 16 kHz mono 16-bit, appended every second
//   call.pcm    the call side the same way (Windows loopback), or
//   call.wav    the call side as the macOS helper writes it
//
// and Stop turns the parts into recording.wav (stereo: me left, call right).
// If the app quits, crashes or the Mac loses power first, the parts are still
// there: the next launch assembles whatever was written (state "ready",
// interrupted). A ready recording stays until its transcript is in history —
// so a busy or unreachable host can't lose it either — and is listed in
// History with a Transcribe button until then.

export const SAMPLE_RATE = 16000;

export type Side = 'me' | 'call';

interface RecordingMeta {
  id: string;
  name: string;
  createdAt: number;
  state: 'recording' | 'ready';
  /** Assembled from what was on disk after the app stopped mid-recording. */
  interrupted?: boolean;
  meStartedAt?: number;
  callStartedAt?: number;
  /** Who spoke when (Meet's captions, from the extension) — sent along as
   * speaker_timeline when it's transcribed. */
  speakerTimeline?: string;
}

export interface PendingRecording {
  id: string;
  name: string;
  createdAt: number;
  state: 'recording' | 'ready';
  interrupted: boolean;
  size: number;
  seconds: number;
}

const ID_RE = /^[a-f0-9]{1,32}$/;
const FSYNC_EVERY_MS = 10_000;

/** The recording being made right now (at most one). */
let active: string | null = null;
const open = new Map<string, { fd: number; syncedAt: number }>();

const dirOf = (userDataDir: string, id: string) => path.join(userDataDir, 'recordings', id);
const metaPath = (userDataDir: string, id: string) => path.join(dirOf(userDataDir, id), 'meta.json');
const wavPath = (userDataDir: string, id: string) => path.join(dirOf(userDataDir, id), 'recording.wav');

function readMeta(userDataDir: string, id: string): RecordingMeta | null {
  if (!ID_RE.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath(userDataDir, id), 'utf-8'));
  } catch {
    return null;
  }
}

function writeMeta(userDataDir: string, meta: RecordingMeta): void {
  const file = metaPath(userDataDir, meta.id);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(meta));
  fs.renameSync(`${file}.tmp`, file);
}

export function activeRecording(): string | null {
  return active;
}

/** Starts a new recording folder; returns its id. */
export function beginRecording(userDataDir: string, name: string): string {
  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  fs.mkdirSync(dirOf(userDataDir, id), { recursive: true });
  const safeName = name.replace(/[\\/:*?"<>|]/g, '-').slice(0, 120) || 'Call.wav';
  writeMeta(userDataDir, { id, name: safeName, createdAt: Date.now(), state: 'recording' });
  active = id;
  return id;
}

/** Stores a recording made elsewhere — the Meet extension hands its WAV
 * over before sending it off, so it shows up in History even if that fails. */
export function addFinishedRecording(userDataDir: string, name: string, wav: Buffer, speakerTimeline?: string): string {
  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  fs.mkdirSync(dirOf(userDataDir, id), { recursive: true });
  fs.writeFileSync(wavPath(userDataDir, id), wav);
  const safeName = name.replace(/[\\/:*?"<>|]/g, '-').slice(0, 120) || 'Meet.wav';
  writeMeta(userDataDir, {
    id,
    name: safeName,
    createdAt: Date.now(),
    state: 'ready',
    speakerTimeline: speakerTimeline || undefined,
  });
  return id;
}

/** Where the macOS helper writes the call side of recording `id`. */
export function macCallWavPath(userDataDir: string, id: string): string {
  return path.join(dirOf(userDataDir, id), 'call.wav');
}

/** Records when a side's first sample was captured (epoch ms) — the two
 * sides are lined up by these. Only the first call per side counts. */
export function setSideStart(userDataDir: string, id: string, side: Side, startedAt: number): void {
  const meta = readMeta(userDataDir, id);
  if (!meta || meta.state !== 'recording') return;
  const key = side === 'me' ? 'meStartedAt' : 'callStartedAt';
  if (meta[key]) return;
  meta[key] = startedAt;
  writeMeta(userDataDir, meta);
}

/** Appends 16-bit PCM to one side of the recording being made. */
export function appendRecording(userDataDir: string, id: string, side: Side, startedAt: number, pcm: Buffer): void {
  if (id !== active || (side !== 'me' && side !== 'call')) return;
  setSideStart(userDataDir, id, side, startedAt);
  const key = `${id}/${side}`;
  let entry = open.get(key);
  if (!entry) {
    entry = { fd: fs.openSync(path.join(dirOf(userDataDir, id), `${side}.pcm`), 'a'), syncedAt: Date.now() };
    open.set(key, entry);
  }
  fs.writeSync(entry.fd, pcm);
  // Written data can sit in the OS cache for a while; a power cut would take
  // it along. Flushing every few seconds bounds that loss.
  if (Date.now() - entry.syncedAt > FSYNC_EVERY_MS) {
    fs.fsyncSync(entry.fd);
    entry.syncedAt = Date.now();
  }
}

function closeFiles(id: string): void {
  for (const side of ['me', 'call']) {
    const entry = open.get(`${id}/${side}`);
    if (!entry) continue;
    try {
      fs.closeSync(entry.fd);
    } catch {
      // already closed
    }
    open.delete(`${id}/${side}`);
  }
}

interface PcmSource {
  fd: number;
  /** Byte offset of the first sample. */
  start: number;
  frames: number;
}

/** Raw PCM, or a WAV's data chunk. A WAV cut short (the helper was killed)
 * may claim a wrong size — then the data runs to the end of the file. */
function openSource(file: string): PcmSource | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  const size = fs.fstatSync(fd).size;
  if (file.endsWith('.pcm')) return { fd, start: 0, frames: Math.floor(size / 2) };

  const head = Buffer.alloc(8);
  let offset = 12;
  while (offset + 8 <= size) {
    fs.readSync(fd, head, 0, 8, offset);
    const id = head.toString('ascii', 0, 4);
    const chunkSize = head.readUInt32LE(4);
    if (id === 'data') {
      const start = offset + 8;
      const bytes = chunkSize > 0 && start + chunkSize <= size ? chunkSize : size - start;
      return { fd, start, frames: Math.floor(bytes / 2) };
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  fs.closeSync(fd);
  return null;
}

function wavHeader(frames: number): Buffer {
  const dataSize = frames * 4;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataSize, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(2, 22); // stereo
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataSize, 40);
  return h;
}

/** Lines both sides up by their start times and interleaves them into
 * recording.wav, a second at a time (an hour is ~230 MB — never all in
 * memory at once). */
function assemble(userDataDir: string, meta: RecordingMeta): void {
  const dir = dirOf(userDataDir, meta.id);
  const me = openSource(path.join(dir, 'me.pcm'));
  const call = openSource(path.join(dir, 'call.wav')) ?? openSource(path.join(dir, 'call.pcm'));
  try {
    const sides = [
      { src: me, startedAt: meta.meStartedAt },
      { src: call, startedAt: meta.callStartedAt ?? meta.meStartedAt },
    ];
    const starts = sides.filter((s) => s.src?.frames && s.startedAt).map((s) => s.startedAt!);
    const t0 = starts.length ? Math.min(...starts) : 0;
    const offsetOf = (s: (typeof sides)[number]) =>
      s.src?.frames && s.startedAt ? Math.round(((s.startedAt - t0) / 1000) * SAMPLE_RATE) : 0;
    const total = Math.max(...sides.map((s) => (s.src ? offsetOf(s) + s.src.frames : 0)));

    const tmp = `${wavPath(userDataDir, meta.id)}.tmp`;
    const out = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(out, wavHeader(total));
      const block = SAMPLE_RATE;
      const outBuf = Buffer.alloc(block * 4);
      const inBuf = Buffer.alloc(block * 2);
      for (let frame = 0; frame < total; frame += block) {
        const n = Math.min(block, total - frame);
        outBuf.fill(0, 0, n * 4);
        sides.forEach((s, channel) => {
          if (!s.src) return;
          // Which of this side's samples land in [frame, frame + n).
          const from = Math.max(0, frame - offsetOf(s));
          const to = Math.min(s.src.frames, frame + n - offsetOf(s));
          if (to <= from) return;
          const read = fs.readSync(s.src.fd, inBuf, 0, (to - from) * 2, s.src.start + from * 2);
          const at = offsetOf(s) + from - frame;
          for (let i = 0; i < Math.floor(read / 2); i++) outBuf.writeInt16LE(inBuf.readInt16LE(i * 2), (at + i) * 4 + channel * 2);
        });
        fs.writeSync(out, outBuf, 0, n * 4);
      }
      fs.fsyncSync(out);
    } finally {
      fs.closeSync(out);
    }
    fs.renameSync(tmp, wavPath(userDataDir, meta.id));
  } finally {
    if (me) fs.closeSync(me.fd);
    if (call) fs.closeSync(call.fd);
  }
  for (const part of ['me.pcm', 'call.pcm', 'call.wav']) fs.rmSync(path.join(dir, part), { force: true });
}

/** Turns a recording's parts into recording.wav. `interrupted`: the app
 * stopped before the user did. */
export function finishRecording(userDataDir: string, id: string, interrupted = false): PendingRecording | null {
  if (id === active) active = null;
  closeFiles(id);
  const meta = readMeta(userDataDir, id);
  if (!meta) return null;
  if (meta.state === 'recording') {
    assemble(userDataDir, meta);
    meta.state = 'ready';
    if (interrupted) meta.interrupted = true;
    writeMeta(userDataDir, meta);
  }
  return describe(userDataDir, meta);
}

function describe(userDataDir: string, meta: RecordingMeta): PendingRecording {
  let size = 0;
  if (meta.state === 'ready') {
    try {
      size = fs.statSync(wavPath(userDataDir, meta.id)).size;
    } catch {
      // missing — reported as empty
    }
  }
  return {
    id: meta.id,
    name: meta.name,
    createdAt: meta.createdAt,
    state: meta.state,
    interrupted: !!meta.interrupted,
    size,
    seconds: Math.max(0, Math.round((size - 44) / 4 / SAMPLE_RATE)),
  };
}

/** Every recording not yet transcribed, newest first. One left "recording"
 * by an app that's no longer making it is assembled on the spot. */
export function listRecordings(userDataDir: string): PendingRecording[] {
  let ids: string[];
  try {
    ids = fs.readdirSync(path.join(userDataDir, 'recordings')).filter((id) => ID_RE.test(id));
  } catch {
    return [];
  }
  const items: PendingRecording[] = [];
  for (const id of ids) {
    const meta = readMeta(userDataDir, id);
    if (!meta) continue;
    try {
      items.push(
        meta.state === 'recording' && id !== active
          ? finishRecording(userDataDir, id, true)!
          : describe(userDataDir, meta),
      );
    } catch {
      // unreadable parts — leave the folder for a later try
    }
  }
  return items.sort((a, b) => b.createdAt - a.createdAt);
}

export function readRecording(userDataDir: string, id: string): { data: Buffer; speakerTimeline?: string } | null {
  const meta = readMeta(userDataDir, id);
  if (!meta || meta.state !== 'ready') return null;
  try {
    return { data: fs.readFileSync(wavPath(userDataDir, id)), speakerTimeline: meta.speakerTimeline };
  } catch {
    return null;
  }
}

/** The file to reveal in Finder / Explorer: the WAV once ready, else the folder. */
export function recordingPath(userDataDir: string, id: string): string | null {
  const meta = readMeta(userDataDir, id);
  if (!meta) return null;
  return meta.state === 'ready' ? wavPath(userDataDir, id) : dirOf(userDataDir, id);
}

export function deleteRecording(userDataDir: string, id: string): boolean {
  if (!readMeta(userDataDir, id)) return false;
  if (id === active) active = null;
  closeFiles(id);
  fs.rmSync(dirOf(userDataDir, id), { recursive: true, force: true });
  return true;
}
