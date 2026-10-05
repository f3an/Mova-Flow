import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

// Whisper picks one language per file (or takes the one the user chose) and
// decodes everything as that language — speech in another one comes back
// *translated*: a Ukrainian interview's English part came out in Ukrainian,
// and partly garbled. Whisper's own language detection can't be trusted to
// spot it either: large-v3 calls Ukrainian-accented English "uk".
//
// So after a side is transcribed, its speech is cut into ~30 s windows and
// each is checked with the tiny model (fast, and it does hear the accented
// English as English). A window where tiny hears another language is decoded
// again by the main model in both languages, and whichever decode the model
// is more confident in wins: a faithful transcript scores clearly higher
// than a translation (mean token log-probability -0.15..-0.28 vs -0.51..-0.61
// on the interview, and the other way round for its Ukrainian parts).

export interface Word {
  start: number;
  end: number;
  text: string;
}

export interface MixedLanguageTools {
  exe: string;
  model: string;
  /** ggml-tiny.bin — used only to spot windows worth a second look. */
  tinyModel: string;
  /** --vad args, or [] when VAD isn't available. */
  vadArgs: string[];
  tmpDir: string;
}

const SAMPLE_RATE = 16000;
const WINDOW_S = 30;
/** tiny confuses these with each other; a switch between them isn't worth
 * the second look (and is rarely mid-conversation anyway). */
const FAMILIES = [['uk', 'ru', 'be']];
const MIN_TINY_P = 0.3;
/** How much more confident the other language's decode has to be. */
const MARGIN = 0.1;

function sameFamily(a: string, b: string): boolean {
  return a === b || FAMILIES.some((f) => f.includes(a) && f.includes(b));
}

function run(exe: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: path.dirname(exe) });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf-8')));
    child.stderr.on('data', (c: Buffer) => (out += c.toString('utf-8')));
    child.on('error', reject);
    child.on('close', () => resolve(out));
  });
}

/** 16-bit mono PCM of a WAV written by splitStereoWav (44-byte header). */
function readPcm(file: string): Int16Array {
  const data = fs.readFileSync(file);
  return new Int16Array(data.buffer.slice(data.byteOffset + 44, data.byteOffset + data.length - ((data.length - 44) % 2)));
}

function writeWav(file: string, samples: Int16Array): void {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(samples.length * 2, 40);
  fs.writeFileSync(file, Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]));
}

const slice = (pcm: Int16Array, from: number, to: number) =>
  pcm.subarray(Math.max(0, Math.floor(from * SAMPLE_RATE)), Math.min(pcm.length, Math.ceil(to * SAMPLE_RATE)));

/** Spans of speech (words closer than 1 s joined), grouped into windows of
 * up to WINDOW_S seconds of speech each. */
function speechWindows(words: Word[]): { start: number; end: number; spans: [number, number][] }[] {
  const spans: [number, number][] = [];
  for (const w of words) {
    if (!w.text.trim()) continue;
    const last = spans[spans.length - 1];
    if (last && w.start - last[1] < 1) last[1] = Math.max(last[1], w.end);
    else spans.push([w.start, w.end]);
  }
  const windows: { start: number; end: number; spans: [number, number][] }[] = [];
  let speech = 0;
  for (const span of spans) {
    const length = span[1] - span[0];
    const last = windows[windows.length - 1];
    if (last && speech + length <= WINDOW_S) {
      last.spans.push(span);
      last.end = span[1];
      speech += length;
    } else {
      windows.push({ start: span[0], end: span[1], spans: [span] });
      speech = length;
    }
  }
  return windows;
}

async function detect(tools: MixedLanguageTools, file: string): Promise<{ lang: string; p: number } | null> {
  const out = await run(tools.exe, ['-m', tools.tinyModel, '-f', file, '-l', 'auto', '-dl']);
  const m = /auto-detected language:\s*(\w+)\s*\(p\s*=\s*([\d.]+)\)/i.exec(out);
  return m ? { lang: m[1], p: Number(m[2]) } : null;
}

/** Word-level decode of `file` in `lang`, with the model's mean token
 * log-probability as its confidence. */
async function decode(tools: MixedLanguageTools, file: string, lang: string): Promise<{ words: Word[]; score: number }> {
  const base = `${file}.${lang}`;
  await run(tools.exe, [
    '-m', tools.model, '-f', file, '-l', lang, '-mc', '0', '-ml', '1', '-sow',
    ...tools.vadArgs, '-np', '-ojf', '-of', base,
  ]);
  try {
    const json = JSON.parse(fs.readFileSync(`${base}.json`, 'utf-8')) as {
      transcription: { offsets: { from: number; to: number }; text: string; tokens: { text: string; p: number }[] }[];
    };
    const logs: number[] = [];
    const words = json.transcription.map((s) => {
      for (const t of s.tokens) if (!t.text.startsWith('[_')) logs.push(Math.log(Math.max(t.p, 1e-6)));
      return { start: s.offsets.from / 1000, end: s.offsets.to / 1000, text: s.text };
    });
    return { words, score: logs.length ? logs.reduce((a, b) => a + b, 0) / logs.length : -Infinity };
  } catch {
    return { words: [], score: -Infinity };
  } finally {
    fs.rmSync(`${base}.json`, { force: true });
  }
}

/** Returns `words` with every stretch of speech in another language
 * replaced by its transcript in that language. `mainLang` is the language
 * the side was decoded in. */
export async function fixOtherLanguages(
  tools: MixedLanguageTools,
  channelWav: string,
  words: Word[],
  mainLang: string,
  onProgress: (message: string) => void,
): Promise<Word[]> {
  if (!fs.existsSync(tools.tinyModel) || !mainLang || mainLang === 'auto') return words;
  const pcm = readPcm(channelWav);
  const windows = speechWindows(words);
  const clip = path.join(tools.tmpDir, `mixed-${process.pid}-${Date.now()}.wav`);

  // 1. Which windows might be in another language.
  const candidates: { start: number; end: number; lang: string }[] = [];
  for (let i = 0; i < windows.length; i++) {
    onProgress(`Checking for other languages... ${i + 1}/${windows.length}`);
    const w = windows[i];
    const parts = w.spans.map(([a, b]) => slice(pcm, a - 0.1, b + 0.1));
    const speech = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      speech.set(p, at);
      at += p.length;
    }
    if (speech.length < SAMPLE_RATE * 2) continue; // too short to tell
    writeWav(clip, speech);
    const found = await detect(tools, clip);
    if (!found || found.p < MIN_TINY_P || sameFamily(found.lang, mainLang)) continue;
    const last = candidates[candidates.length - 1];
    if (last && last.lang === found.lang && w.start - last.end < 5) last.end = w.end;
    else candidates.push({ start: w.start, end: w.end, lang: found.lang });
  }

  // 2. Decode each in both languages; keep the more confident one.
  let result = words;
  for (const [i, c] of candidates.entries()) {
    onProgress(`Checking for other languages... ${c.lang} ${i + 1}/${candidates.length}`);
    const from = Math.max(0, c.start - 0.3);
    writeWav(clip, slice(pcm, from, c.end + 0.3));
    const other = await decode(tools, clip, c.lang);
    const main = await decode(tools, clip, mainLang);
    if (!other.words.length || other.score < main.score + MARGIN) continue;
    const moved = other.words.map((w) => ({ start: w.start + from, end: w.end + from, text: w.text }));
    result = [
      ...result.filter((w) => w.end <= c.start - 0.05 || w.start >= c.end + 0.05),
      ...moved,
    ].sort((a, b) => a.start - b.start);
  }
  fs.rmSync(clip, { force: true });
  return result;
}
