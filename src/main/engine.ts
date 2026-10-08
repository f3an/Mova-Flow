import * as path from 'path';
import * as fs from 'fs';
import { execFile, spawn } from 'child_process';
import { downloadFile } from './download';
import { downloadGhcrArtifact } from './ghcr';
import { SpeakerTurn, speakerAt } from './speakerNames';
import { fixOtherLanguages, isPcmFormat, MixedLanguageTools, readJsonWords, Word, wordTimes } from './mixedLanguage';
import { applyReplacements, EMPTY_VOCABULARY, Vocabulary, vocabularyPrompt } from './vocabulary';

// Precompiled Windows builds of whisper.cpp are published under build tags
// (b####), not version tags (v1.9.x) — the latter no longer ship binaries.
// Verified manually: whisper-cli.exe from whisper-cublas-12.4.0-bin-x64.zip
// correctly uses CUDA on an RTX 4060.
const WHISPER_CPP_TAG = 'b5130';
const CUDA_ASSET = 'whisper-cublas-12.4.0-bin-x64.zip';
const CPU_ASSET = 'whisper-bin-x64.zip';

// ggml-org/whisper.cpp does not publish a macOS binary in its releases (only
// Windows zips and an Ubuntu tar.gz — checked across several recent build
// tags). .github/workflows/build-whisper-macos.yml compiles one from source
// on an Apple Silicon runner instead — a single static binary with Metal
// embedded, so there's no GPU/CPU split to choose between like on Windows.
// It's published to GitHub Packages (GHCR), not a GitHub Release: the
// Releases page here is tag-only (app versions), and this artifact tracks an
// upstream whisper.cpp build tag instead, on its own cadence.
const MAC_ASSET = 'whisper-cpp-macos-arm64.zip';
const GHCR_OWNER = 'f3an';
const GHCR_PACKAGE = 'whisper-cli-macos-arm64';
// Mirrors of everything else the engine downloads (Windows binaries, Whisper
// and VAD models) — see mirror-engine-assets.yml. Tried first; the upstream
// URLs are only a fallback, so the app keeps working if upstream files move
// or disappear, and keeps working on upstream if the mirror is unreachable.
const GHCR_WINDOWS_PACKAGE = 'whisper-cli-windows-x64';
const GHCR_MODELS_PACKAGE = 'whisper-models';

/** Tries each source in order, returning on the first that succeeds; the
 * error that surfaces if they all fail is the last (upstream) one. */
async function downloadFromAny(sources: (() => Promise<void>)[]): Promise<void> {
  let lastError: unknown;
  for (const source of sources) {
    try {
      await source();
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// Common ggml builds published under ggerganov/whisper.cpp on HuggingFace.
export const MODEL_PRESETS = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'] as const;
export type ModelPreset = (typeof MODEL_PRESETS)[number];
export const DEFAULT_MODEL_PRESET: ModelPreset = 'large-v3';

export interface ModelChoice {
  // Absolute path to a model file the user picked themselves — takes priority
  // over `preset` when non-empty, and is never auto-downloaded.
  customPath: string;
  preset: ModelPreset;
}

export type ProgressCb = (message: string) => void;

function engineDir(userDataDir: string): string {
  return path.join(userDataDir, 'engine');
}

// Silero voice-activity model for whisper-cli --vad. Without it, Whisper
// decodes silence too: a recording that opens with a minute of quiet gets
// its language guessed from nothing (e.g. "nn" at p=0.52), hallucinates a
// stock subtitle line ("Takk for at du så med."), and — conditioning on its
// own previous text — repeats it over the real speech for the whole file.
// With VAD only actual speech is decoded; timestamps still map back to the
// original recording, and --diarize channel labels keep working.
const VAD_MODEL_FILE = 'ggml-silero-v5.1.2.bin';
const VAD_MODEL_URL = `https://huggingface.co/ggml-org/whisper-vad/resolve/main/${VAD_MODEL_FILE}`;
const VAD_MIRROR_TAG = 'silero-v5.1.2';

function vadModelPath(userDataDir: string): string {
  return path.join(engineDir(userDataDir), VAD_MODEL_FILE);
}

// The tiny model names the other language in an English file (see
// mixedLanguage.ts). Optional, like VAD: without it only English is tried
// for stretches in another language.
function tinyModelPath(userDataDir: string): string {
  return path.join(engineDir(userDataDir), 'ggml-tiny.bin');
}

// Asked once per engine binary: an older whisper-cli without --vad (or
// --carry-initial-prompt) would reject the flag and fail the whole job, where
// skipping it only costs accuracy.
const cliHelp = new Map<string, Promise<string>>();

function cliSupports(exe: string, flag: string): Promise<boolean> {
  let help = cliHelp.get(exe);
  if (!help) {
    help = new Promise((resolve) => {
      execFile(exe, ['--help'], { cwd: path.dirname(exe), timeout: 10000 }, (_err, stdout, stderr) =>
        resolve(`${stdout}${stderr}`),
      );
    });
    cliHelp.set(exe, help);
  }
  return help.then((text) => new RegExp(`${flag}\\b`).test(text));
}

const cliSupportsVad = (exe: string) => cliSupports(exe, '--vad');

function binDir(userDataDir: string): string {
  return path.join(engineDir(userDataDir), 'bin');
}

export function cliPath(userDataDir: string): string {
  // Windows' zip keeps the MSVC multi-config layout (bin/Release/*.exe);
  // our own macOS build (see build-whisper-macos.yml) is a single-config
  // CMake build, so the binary lands straight in bin/ with no extension.
  return process.platform === 'darwin'
    ? path.join(binDir(userDataDir), 'whisper-cli')
    : path.join(binDir(userDataDir), 'Release', 'whisper-cli.exe');
}

export function modelPath(userDataDir: string, choice: ModelChoice): string {
  if (choice.customPath) return choice.customPath;
  return path.join(engineDir(userDataDir), `ggml-${choice.preset}.bin`);
}

/** GPU detection via nvidia-smi (ships with the driver) — no CUDA Toolkit needed. */
export function detectGpu(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

/** Unzips via each OS's own built-in tool — avoids an npm dependency like
 * extract-zip, which has an unpatched symlink vulnerability. Windows uses
 * PowerShell's Expand-Archive; macOS ships `unzip` out of the box. */
/** Wherever the archive put whisper-cli, moves it to cliPath(). The macOS
 * artifact was rebuilt with a bin/ folder inside (bin/bin/whisper-cli once
 * extracted into bin/), which broke every new Mac host install with
 * "ENOENT ... chmod .../engine/bin/whisper-cli". Also repairs an install
 * left in that state. */
export function placeCli(userDataDir: string): void {
  const target = cliPath(userDataDir);
  if (fs.existsSync(target)) return;
  const name = path.basename(target);
  const find = (dir: string, depth: number): string | null => {
    if (depth > 4) return null;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) if (e.isFile() && e.name === name) return path.join(dir, e.name);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const found = find(path.join(dir, e.name), depth + 1);
      if (found) return found;
    }
    return null;
  };
  const found = find(binDir(userDataDir), 0);
  if (!found) throw new Error(`The recognition engine archive has no ${name}.`);
  // Everything next to it moves along: on Windows the DLLs it needs sit in
  // the same folder.
  const from = path.dirname(found);
  const to = path.dirname(target);
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from)) fs.renameSync(path.join(from, entry), path.join(to, entry));
}

function expandArchive(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, args] =
      process.platform === 'darwin'
        ? ['unzip', ['-o', zipPath, '-d', destDir]]
        : [
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive', '-Path', zipPath, '-DestinationPath', destDir, '-Force'],
          ];
    execFile(cmd as string, args as string[], (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}

/** Fetches the heavy components (whisper.cpp binary + GGUF model) into userData
 * if they're not already there — the equivalent of the Python version's staged
 * pip-install, now just a plain HTTP download. */
export async function ensureEngine(userDataDir: string, model: ModelChoice, onProgress: ProgressCb): Promise<void> {
  const eDir = engineDir(userDataDir);
  fs.mkdirSync(eDir, { recursive: true });

  // An install left by the bin/bin/ archive layout (see placeCli).
  if (!fs.existsSync(cliPath(userDataDir))) {
    try {
      placeCli(userDataDir);
      if (process.platform === 'darwin') fs.chmodSync(cliPath(userDataDir), 0o755);
    } catch {
      // nothing usable there — download below
    }
  }

  if (!fs.existsSync(cliPath(userDataDir))) {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      throw new Error(`The server (host) role isn't supported on ${process.platform} yet — only Windows and macOS.`);
    }

    const onDownloadProgress = (received: number, total: number) => {
      if (total > 0) onProgress(`Downloading recognition engine... ${Math.round((received / total) * 100)}%`);
    };

    let zipPath: string;
    if (process.platform === 'darwin') {
      zipPath = path.join(eDir, MAC_ASSET);
      onProgress('Downloading recognition engine (Apple Silicon, Metal-accelerated)...');
      await downloadGhcrArtifact(GHCR_OWNER, GHCR_PACKAGE, WHISPER_CPP_TAG, zipPath, onDownloadProgress);
    } else {
      const hasGpu = await detectGpu();
      const winAsset = hasGpu ? CUDA_ASSET : CPU_ASSET;
      const finalZipPath = path.join(eDir, winAsset);
      zipPath = finalZipPath;
      const url = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_TAG}/${winAsset}`;
      const mirrorTag = `${WHISPER_CPP_TAG}-${hasGpu ? 'cuda' : 'cpu'}`;
      onProgress(`Downloading recognition engine (${hasGpu ? 'GPU' : 'CPU'})...`);
      await downloadFromAny([
        () => downloadGhcrArtifact(GHCR_OWNER, GHCR_WINDOWS_PACKAGE, mirrorTag, finalZipPath, onDownloadProgress),
        () => downloadFile(url, finalZipPath, onDownloadProgress),
      ]);
    }

    onProgress('Extracting recognition engine...');
    fs.mkdirSync(binDir(userDataDir), { recursive: true });
    await expandArchive(zipPath, binDir(userDataDir));
    fs.unlinkSync(zipPath);
    placeCli(userDataDir);

    if (process.platform === 'darwin') fs.chmodSync(cliPath(userDataDir), 0o755);
  }

  const mPath = modelPath(userDataDir, model);
  if (model.customPath) {
    if (!fs.existsSync(mPath)) {
      throw new Error(`Selected model file not found: ${mPath}`);
    }
    return;
  }

  if (!fs.existsSync(mPath)) {
    const filename = `ggml-${model.preset}.bin`;
    const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${filename}`;
    onProgress(`Downloading model (${filename})...`);
    const onModelProgress = (received: number, total: number) => {
      if (total > 0) onProgress(`Downloading model... ${Math.round((received / total) * 100)}%`);
    };
    await downloadFromAny([
      () => downloadGhcrArtifact(GHCR_OWNER, GHCR_MODELS_PACKAGE, model.preset, mPath, onModelProgress),
      () => downloadFile(url, mPath, onModelProgress),
    ]);
  }

  // Also fetched on the next start for engines installed before VAD existed.
  // Optional: if it can't be downloaded, transcription still runs without it.
  const vPath = vadModelPath(userDataDir);
  if (!fs.existsSync(vPath)) {
    onProgress('Downloading voice-activity model...');
    try {
      await downloadFromAny([
        () => downloadGhcrArtifact(GHCR_OWNER, GHCR_MODELS_PACKAGE, VAD_MIRROR_TAG, vPath),
        () => downloadFile(VAD_MODEL_URL, vPath, () => {}),
      ]);
    } catch {
      fs.rmSync(vPath, { force: true });
    }
  }

  const tPath = tinyModelPath(userDataDir);
  if (!fs.existsSync(tPath)) {
    onProgress('Downloading language-detection model...');
    try {
      await downloadFromAny([
        () => downloadGhcrArtifact(GHCR_OWNER, GHCR_MODELS_PACKAGE, 'tiny', tPath),
        () => downloadFile('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin', tPath, () => {}),
      ]);
    } catch {
      fs.rmSync(tPath, { force: true });
    }
  }
}

function formatTimestamp(totalSeconds: number): string {
  const s = Math.floor(totalSeconds % 60);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const SEGMENT_RE = /^\[(\d{2}):(\d{2}):(\d{2}\.\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2}\.\d{3})\]\s*(.*)$/;
// Not "lang = auto" from the "main: processing ..." line (that's just the -l flag
// echoed back, not a result) — the actual detection result is on its own line
// from whisper_full_with_state.
const LANG_RE = /auto-detected language:\s*(\w+)/i;

// With --diarize, whisper-cli prefixes each segment with the channel that was
// louder while it was spoken: "(speaker 0)" = left, "(speaker 1)" = right,
// "(speaker ?)" = neither clearly dominated (crosstalk, silence).
const SPEAKER_RE = /^\(speaker ([01?])\)\s*/;

/** Labels for a stereo recording whose two channels are two different sides
 * of a conversation — the meet recorder puts the user's mic on the left and
 * the call's audio on the right. */
export interface SpeakerLabels {
  left: string;
  right: string;
  /** Meet caption turns — names the right-channel speaker per segment
   * instead of the generic `right` label wherever captions cover it. */
  timeline?: SpeakerTurn[];
}

function speakerLabel(channel: string, start: number, end: number, speakers: SpeakerLabels): string | null {
  // The mic channel is always the user, whatever the captions say.
  if (channel === '0') return speakers.left;
  // Crosstalk ("?") gets a name only if captions clearly place someone else
  // there — otherwise it stays unlabeled rather than guessing a side.
  const named = speakers.timeline?.length ? speakerAt(speakers.timeline, start, end) : null;
  if (channel === '1') return named || speakers.right;
  return named;
}

export interface TranscribeResult {
  text: string;
  detectedLanguage: string;
}

type Segment = Word;

/** Spawns whisper-cli.exe as a child process (not a native binding — the same
 * lesson as the pip-worker hack in the Python version) and parses segments off
 * stdout as they stream in. */
function runWhisper(
  exe: string,
  args: string[],
  language: string,
  onSegment: (segment: Segment) => void,
  /** Also write -ojf JSON here and take the segments from it — they then
   * carry the model's confidence (see mixedLanguage.ts). */
  jsonBase?: string,
): Promise<{ segments: Segment[]; detectedLanguage: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, jsonBase ? [...args, '-ojf', '-of', jsonBase] : args, { cwd: path.dirname(exe) });
    const segments: Segment[] = [];
    let detectedLanguage = language !== 'auto' ? language : '';
    let buffer = '';
    let tail = '';

    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      tail = (tail + text).slice(-4000);
      if (!detectedLanguage) {
        const langMatch = LANG_RE.exec(text);
        if (langMatch) detectedLanguage = langMatch[1];
      }

      buffer += text;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        const m = SEGMENT_RE.exec(line);
        if (m) {
          const [, sh, sm, ss, eh, em, es] = m;
          const segment = {
            start: Number(sh) * 3600 + Number(sm) * 60 + Number(ss),
            end: Number(eh) * 3600 + Number(em) * 60 + Number(es),
            text: m[7],
          };
          segments.push(segment);
          onSegment(segment);
        }
      }
    };

    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`whisper-cli exited with code ${code}: ${tail.trim().slice(-500)}`));
        return;
      }
      // whisper-cli exits 0 even when it fails to decode the file (e.g. an
      // unsupported audio format) — the only signal is this text in stderr.
      if (/failed to read audio/i.test(tail)) {
        reject(new Error('Could not read the audio file: unsupported or corrupted format.'));
        return;
      }
      let result = segments;
      if (jsonBase) {
        result = readJsonWords(`${jsonBase}.json`) ?? segments;
        fs.rmSync(`${jsonBase}.json`, { force: true });
      }
      resolve({ segments: result, detectedLanguage: detectedLanguage || 'auto' });
    });
  });
}

// ── Stereo "me / others" recordings ──────────────────────────────────────
// Each side is transcribed on its own rather than as a mix labelled by the
// louder channel: when both people talk at once, a mix gets only one of them
// transcribed — and the louder channel isn't necessarily the voice Whisper
// picked (a recording of the user talking over a video came back with the
// video's words, the mic channel louder, and no label at all).

/** Splits a 16-bit PCM stereo WAV into two mono WAVs (left, right) next to
 * it; null if the file is anything else, so the caller can fall back. */
function splitStereoWav(filePath: string): { left: string; right: string } | null {
  let data: Buffer;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = { format: isPcmFormat(data, body, size) ? 1 : data.readUInt16LE(body), channels: data.readUInt16LE(body + 2), rate: data.readUInt32LE(body + 4), bits: data.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 2 || fmt.bits !== 16) return null;
      const frames = Math.floor(Math.min(size, data.length - body) / 4);
      const write = (channel: number, suffix: string) => {
        const out = Buffer.alloc(44 + frames * 2);
        out.write('RIFF', 0, 'ascii');
        out.writeUInt32LE(36 + frames * 2, 4);
        out.write('WAVEfmt ', 8, 'ascii');
        out.writeUInt32LE(16, 16);
        out.writeUInt16LE(1, 20);
        out.writeUInt16LE(1, 22);
        out.writeUInt32LE(fmt!.rate, 24);
        out.writeUInt32LE(fmt!.rate * 2, 28);
        out.writeUInt16LE(2, 32);
        out.writeUInt16LE(16, 34);
        out.write('data', 36, 'ascii');
        out.writeUInt32LE(frames * 2, 40);
        for (let i = 0; i < frames; i++) out.writeInt16LE(data.readInt16LE(body + i * 4 + channel * 2), 44 + i * 2);
        const target = `${filePath}.${suffix}.wav`;
        fs.writeFileSync(target, out);
        return target;
      };
      return { left: write(0, 'me'), right: write(1, 'call') };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/** Drops the decoder's loops: a line (3+ words) that repeats one of the last
 * few kept lines word for word. Short replies ("Okay.", "Mm-hm.") can
 * genuinely repeat and are left alone. */
function dropRepeats<T extends Segment>(segments: T[]): T[] {
  const recent: string[] = [];
  return segments.filter((segment) => {
    const key = segment.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (key.split(' ').length >= 3 && recent.includes(key)) return false;
    recent.push(key);
    if (recent.length > 4) recent.shift();
    return true;
  });
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean));
}

/** Without headphones the mic also hears the call from the speakers, so the
 * same words can come back on both sides. A mic line that overlaps a call
 * line in time and mostly repeats its words is that echo, not the user. */
function isEcho(mine: Segment, call: Segment[]): boolean {
  const ownWords = words(mine.text);
  if (!ownWords.size) return true;
  const duration = Math.max(mine.end - mine.start, 0.1);
  return call.some((other) => {
    const overlap = Math.min(mine.end, other.end) - Math.max(mine.start, other.start);
    if (overlap < duration * 0.4) return false;
    const theirs = words(other.text);
    let shared = 0;
    for (const w of ownWords) if (theirs.has(w)) shared++;
    return shared / Math.min(ownWords.size, Math.max(theirs.size, 1)) >= 0.6;
  });
}

// Both sides are transcribed word by word (-ml 1 -sow) and regrouped into
// lines here. Whisper's own segments run across pauses: on a call, a reply
// would start back where the speaker last stopped — before the other
// side's question — and the conversation came out of order. Word times
// show where the pause is: whisper stretches a word next to it — the first
// word after it (a new sentence, capitalized) or the last one before it.
const PAUSE_S = 1.2;
/** A line this long is cut at the next sentence end. */
const LONG_LINE_S = 20;

/** Words regrouped into lines: a new line after a pause, where `labelOf`
 * changes (Meet caption names), or at a sentence end once a line is long. */
function wordsToLines(words: Segment[], labelOf: (start: number, end: number) => string): (Segment & { label: string })[] {
  const lines: (Segment & { label: string })[] = [];
  for (const word of words) {
    const text = word.text.trim();
    if (!text) continue;
    const { start, end } = wordTimes(word);
    const label = labelOf(start, end);
    const last = lines[lines.length - 1];
    const joins =
      last &&
      last.label === label &&
      start - last.end < PAUSE_S &&
      !(last.end - last.start > LONG_LINE_S && /[.?!…]$/.test(last.text));
    if (joins) {
      last.end = end;
      last.text += ` ${text}`;
    } else {
      lines.push({ start, end, text, label });
    }
  }
  return lines;
}

async function transcribeChannels(
  exe: string,
  argsFor: (file: string, extra?: string[]) => string[],
  language: string,
  files: { left: string; right: string },
  speakers: SpeakerLabels,
  mixed: MixedLanguageTools,
  onProgress: ProgressCb,
): Promise<TranscribeResult> {
  // One after the other: both at once would just fight over the GPU.
  let count = 0;
  onProgress('Transcribing your side...');
  const me = await runWhisper(
    exe,
    argsFor(files.left, ['-ml', '1', '-sow']),
    language,
    () => onProgress(`Transcribing your side... words: ${++count}`),
    `${files.left}.pass`,
  );
  count = 0;
  onProgress('Transcribing the call...');
  const call = await runWhisper(
    exe,
    argsFor(files.right, ['-ml', '1', '-sow']),
    language,
    () => onProgress(`Transcribing the call... words: ${++count}`),
    `${files.right}.pass`,
  );
  const mainLang = (side: { detectedLanguage: string }) => (language && language !== 'auto' ? language : side.detectedLanguage);
  const meWords = await fixOtherLanguages(mixed, files.left, me.segments, mainLang(me), onProgress);
  const callWords = await fixOtherLanguages(mixed, files.right, call.segments, mainLang(call), onProgress);

  const timeline = speakers.timeline?.length ? speakers.timeline : null;
  const callLines = dropRepeats(
    wordsToLines(callWords, (start, end) => (timeline && speakerAt(timeline, start, end)) || speakers.right),
  );
  const meLines = dropRepeats(wordsToLines(meWords, () => speakers.left));

  const lines = [...meLines.filter((line) => !isEcho(line, callLines)), ...callLines].sort((a, b) => a.start - b.start);

  // Whichever side said more decides the language reported for the file.
  const detectedLanguage = (me.segments.length >= call.segments.length ? me : call).detectedLanguage;
  return {
    text: lines.map((l) => `[${formatTimestamp(l.start)}] ${l.label}: ${l.text.trim()}`).join('\n'),
    detectedLanguage,
  };
}

export async function transcribe(
  userDataDir: string,
  modelFilePath: string,
  filePath: string,
  language: string,
  onProgress: ProgressCb,
  speakers?: SpeakerLabels,
  vocabulary: Vocabulary = EMPTY_VOCABULARY,
): Promise<TranscribeResult> {
  const result = await transcribeText(userDataDir, modelFilePath, filePath, language, onProgress, speakers, vocabulary);
  return { ...result, text: applyReplacements(result.text, vocabulary) };
}

async function transcribeText(
  userDataDir: string,
  modelFilePath: string,
  filePath: string,
  language: string,
  onProgress: ProgressCb,
  speakers: SpeakerLabels | undefined,
  vocabulary: Vocabulary,
): Promise<TranscribeResult> {
  const exe = cliPath(userDataDir);
  const vPath = vadModelPath(userDataDir);
  const vad = fs.existsSync(vPath) && (await cliSupportsVad(exe));
  // The vocabulary's terms as a prompt carried into every window. That needs
  // -mc 1 rather than 0 (0 drops the prompt too) — one token of decoded
  // text, not enough to start a loop.
  const prompt = vocabularyPrompt(vocabulary);
  const contextArgs =
    prompt && (await cliSupports(exe, '--carry-initial-prompt'))
      ? ['-mc', '1', '--prompt', prompt, '--carry-initial-prompt']
      : ['-mc', '0'];
  // whisper-cli defaults to 'en' when -l is omitted — it does NOT auto-detect
  // by default — so auto mode needs an explicit '-l auto' or everything gets
  // forced through as English.
  // -mc 0: don't feed each window the text decoded so far. With it, one
  // misheard phrase on a long recording became the prompt for the next
  // window, and the next — an hour of an interview came back as the same
  // line over and over. Without it lines also come back as whole sentences.
  const argsFor = (file: string, extra: string[] = []) => [
    '-m', modelFilePath, '-f', file, '-l', language || 'auto', ...contextArgs,
    ...extra,
    ...(vad ? ['--vad', '-vm', vPath] : []),
  ];

  const mixed: MixedLanguageTools = {
    exe,
    model: modelFilePath,
    tinyModel: tinyModelPath(userDataDir),
    vadArgs: vad ? ['--vad', '-vm', vPath] : [],
    contextArgs,
    tmpDir: path.dirname(filePath),
  };

  if (speakers) {
    const split = splitStereoWav(filePath);
    if (split) {
      try {
        return await transcribeChannels(exe, argsFor, language, split, speakers, mixed, onProgress);
      } finally {
        fs.rmSync(split.left, { force: true });
        fs.rmSync(split.right, { force: true });
      }
    }
  }

  // Any other file: word by word, regrouped into lines at pauses, with
  // stretches in another language transcribed in that language (the same as
  // each side of a call).
  let count = 0;
  if (!speakers) {
    const pass = await runWhisper(
      exe,
      argsFor(filePath, ['-ml', '1', '-sow']),
      language,
      () => onProgress(`Transcribing... words: ${++count}`),
      `${filePath}.pass`,
    );
    const mainLang = language && language !== 'auto' ? language : pass.detectedLanguage;
    const words = await fixOtherLanguages(mixed, filePath, pass.segments, mainLang, onProgress);
    const lines = dropRepeats(wordsToLines(words, () => ''));
    return {
      text: lines.map((l) => `[${formatTimestamp(l.start)}] ${l.text.trim()}`).join('\n'),
      detectedLanguage: pass.detectedLanguage,
    };
  }

  // A "speakers" file that isn't a 16-bit stereo WAV, as one mix: --diarize
  // still labels lines by the louder channel (a mono file passes through it
  // unharmed: every segment is "?").
  const { segments, detectedLanguage } = await runWhisper(exe, argsFor(filePath, speakers ? ['--diarize'] : []), language, () =>
    onProgress(`Processed segments: ${++count}`),
  );
  const lines = dropRepeats(segments).map((segment) => {
    let text = segment.text;
    const speaker = SPEAKER_RE.exec(text);
    if (speaker && speakers) {
      text = text.slice(speaker[0].length);
      const label = speakerLabel(speaker[1], segment.start, segment.end, speakers);
      if (label) text = `${label}: ${text}`;
    }
    return `[${formatTimestamp(segment.start)}] ${text}`;
  });
  return { text: lines.join('\n'), detectedLanguage };
}
