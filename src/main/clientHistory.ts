import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

// Mirrors server.ts's own HistoryEntry/history.json for the host role, but
// lives entirely in this machine's userData — a client sends its audio
// elsewhere for transcription, and the host is required (see requireLocal in
// server.ts) to forget the job once it's done, so the only place left to keep
// a record of "what I sent and what came back" is here, locally.
export interface ClientHistoryEntry {
  id: string;
  filename: string;
  language: string;
  createdAt: number;
  audioExt: string;
}

const ID_RE = /^[a-f0-9]{1,32}$/;

function historyPath(userDataDir: string): string {
  return path.join(userDataDir, 'client-history.json');
}

function audioDir(userDataDir: string): string {
  return path.join(userDataDir, 'client-audio');
}

function transcriptsDir(userDataDir: string): string {
  return path.join(userDataDir, 'client-transcripts');
}

function loadHistory(userDataDir: string): ClientHistoryEntry[] {
  try {
    return JSON.parse(fs.readFileSync(historyPath(userDataDir), 'utf-8'));
  } catch {
    return [];
  }
}

function saveHistory(userDataDir: string, entries: ClientHistoryEntry[]): void {
  fs.writeFileSync(historyPath(userDataDir), JSON.stringify(entries, null, 2), 'utf-8');
}

export function addClientHistoryEntry(
  userDataDir: string,
  filename: string,
  language: string,
  audioExt: string,
  audioBytes: Buffer,
  text: string,
): ClientHistoryEntry {
  fs.mkdirSync(audioDir(userDataDir), { recursive: true });
  fs.mkdirSync(transcriptsDir(userDataDir), { recursive: true });

  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  fs.writeFileSync(path.join(audioDir(userDataDir), `${id}${audioExt}`), audioBytes);
  fs.writeFileSync(path.join(transcriptsDir(userDataDir), `${id}.txt`), text, 'utf-8');

  const entry: ClientHistoryEntry = { id, filename, language, createdAt: Date.now(), audioExt };
  const entries = loadHistory(userDataDir);
  entries.unshift(entry);
  saveHistory(userDataDir, entries);
  return entry;
}

export function getClientHistory(userDataDir: string): ClientHistoryEntry[] {
  return loadHistory(userDataDir);
}

export function getClientHistoryText(userDataDir: string, id: string): string | null {
  if (!ID_RE.test(id)) return null;
  try {
    return fs.readFileSync(path.join(transcriptsDir(userDataDir), `${id}.txt`), 'utf-8');
  } catch {
    return null;
  }
}

export function getClientHistoryAudio(userDataDir: string, id: string): { data: Buffer; ext: string } | null {
  if (!ID_RE.test(id)) return null;
  const entry = loadHistory(userDataDir).find((e) => e.id === id);
  if (!entry) return null;
  const audioPath = path.join(audioDir(userDataDir), `${id}${entry.audioExt}`);
  try {
    return { data: fs.readFileSync(audioPath), ext: entry.audioExt };
  } catch {
    return null;
  }
}

export function deleteClientHistoryEntry(userDataDir: string, id: string): boolean {
  if (!ID_RE.test(id)) return false;
  const entries = loadHistory(userDataDir);
  const entry = entries.find((e) => e.id === id);
  if (!entry) return false;

  saveHistory(userDataDir, entries.filter((e) => e.id !== id));
  fs.unlink(path.join(audioDir(userDataDir), `${id}${entry.audioExt}`), () => {});
  fs.unlink(path.join(transcriptsDir(userDataDir), `${id}.txt`), () => {});
  return true;
}
