import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

// Whisper picks one language per file (or takes the one the user chose) and
// decodes everything as that language — speech in another one comes back
// *translated*: a Ukrainian interview's English part came out in Ukrainian,
// and partly garbled. Whisper's own language detection can't spot it either:
// large-v3 calls Ukrainian-accented English "uk", and the tiny model is no
// better on two voices mixed into one file.
//
// What does give it away is the model's own confidence: forced to write
// English speech in Ukrainian, it's unsure of its tokens (mean log-prob
// -0.33..-0.61 on the interview) where real Ukrainian scores -0.10..-0.22.
// So the first pass reports per-word confidence (-ojf, no extra cost), its
// speech is cut into ~30 s windows, and only a window scoring below
// SUSPECT is decoded again — in English (or, for an English file, the
// language tiny hears) and in the main language — keeping whichever decode
// the model is more confident in. A faithful transcript wins clearly
// (-0.15..-0.28 vs -0.51..-0.61), and the other way round for Ukrainian.

export interface Word {
  start: number;
  end: number;
  text: string;
  /** Sum of the token log-probabilities and how many tokens — from -ojf. */
  logp?: number;
  tokens?: number;
}

export interface MixedLanguageTools {
  exe: string;
  model: string;
  /** ggml-tiny.bin — names the other language when the main one is English. */
  tinyModel: string;
  /** --vad args, or [] when VAD isn't available. */
  vadArgs: string[];
  /** -mc (and the vocabulary prompt) — the same as the first pass. */
  contextArgs: string[];
  tmpDir: string;
}

const SAMPLE_RATE = 16000;
const WINDOW_S = 30;
/** tiny confuses these with each other; a switch between them isn't worth
 * the second look (and is rarely mid-conversation anyway). */
const FAMILIES = [['uk', 'ru', 'be']];
/** A window this unsure of itself may be another language. */
const SUSPECT = -0.25;
/** How much more confident the other language's decode has to be. */
const MARGIN = 0.1;

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

/** A 16-bit PCM WAV as 16 kHz mono (channels averaged, other rates
 * resampled linearly — plenty for telling languages apart); null for any
 * other format (an mp3 sent straight to the API), which skips the check. */
export function readWavMono16k(file: string): Int16Array | null {
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt: { channels: number; rate: number } | null = null;
  let offset = 12;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (data.readUInt16LE(body) !== 1 || data.readUInt16LE(body + 14) !== 16) return null;
      fmt = { channels: data.readUInt16LE(body + 2), rate: data.readUInt32LE(body + 4) };
    } else if (id === 'data') {
      if (!fmt || !fmt.channels || !fmt.rate) return null;
      const frames = Math.floor(Math.min(size, data.length - body) / (2 * fmt.channels));
      const mono = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) sum += data.readInt16LE(body + (i * fmt.channels + c) * 2);
        mono[i] = sum / fmt.channels;
      }
      if (fmt.rate === SAMPLE_RATE) return Int16Array.from(mono, (v) => Math.round(v));
      const out = new Int16Array(Math.floor((frames * SAMPLE_RATE) / fmt.rate));
      const step = fmt.rate / SAMPLE_RATE;
      for (let i = 0; i < out.length; i++) {
        const x = i * step;
        const j = Math.floor(x);
        const next = mono[Math.min(j + 1, frames - 1)];
        out[i] = Math.round(mono[j] + (next - mono[j]) * (x - j));
      }
      return out;
    }
    offset = body + size + (size % 2);
  }
  return null;
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

/** Words (with confidence) from whisper-cli's -ojf output; null if
 * there's no readable file. */
export function readJsonWords(file: string): Word[] | null {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      transcription: { offsets: { from: number; to: number }; text: string; tokens: { text: string; p: number }[] }[];
    };
    return json.transcription.map((s) => {
      const real = s.tokens.filter((t) => !t.text.startsWith('[_'));
      return {
        start: s.offsets.from / 1000,
        end: s.offsets.to / 1000,
        text: s.text,
        logp: real.reduce((sum, t) => sum + Math.log(Math.max(t.p, 1e-6)), 0),
        tokens: real.length,
      };
    });
  } catch {
    return null;
  }
}

function score(words: Word[]): number {
  let logp = 0;
  let tokens = 0;
  for (const w of words) {
    logp += w.logp ?? 0;
    tokens += w.tokens ?? 0;
  }
  return tokens ? logp / tokens : 0;
}

/** Word-level decode of `file` in `lang`, with the model's mean token
 * log-probability as its confidence. */
async function decode(tools: MixedLanguageTools, file: string, lang: string): Promise<{ words: Word[]; score: number }> {
  const base = `${file}.${lang}`;
  await run(tools.exe, [
    '-m', tools.model, '-f', file, '-l', lang, ...tools.contextArgs, '-ml', '1', '-sow',
    ...tools.vadArgs, '-np', '-ojf', '-of', base,
  ]);
  const words = readJsonWords(`${base}.json`) ?? [];
  fs.rmSync(`${base}.json`, { force: true });
  return { words, score: words.length ? score(words) : -Infinity };
}

/** Returns `words` with every stretch of speech in another language
 * replaced by its transcript in that language. `mainLang` is the language
 * the side was decoded in. */
export async function fixOtherLanguages(
  tools: MixedLanguageTools,
  wavFile: string,
  words: Word[],
  mainLang: string,
  onProgress: (message: string) => void,
): Promise<Word[]> {
  if (!mainLang || mainLang === 'auto' || !words.some((w) => w.tokens)) return words;
  const pcm = readWavMono16k(wavFile);
  if (!pcm) return words;
  const clip = path.join(tools.tmpDir, `mixed-${process.pid}-${Date.now()}.wav`);

  // 1. Windows the first pass was unsure of, merged when next to each other.
  const suspects: { start: number; end: number }[] = [];
  for (const w of speechWindows(words)) {
    if (w.end - w.start < 2) continue;
    if (score(words.filter((x) => x.start >= w.start && x.end <= w.end)) >= SUSPECT) continue;
    const last = suspects[suspects.length - 1];
    if (last && w.start - last.end < 5) last.end = w.end;
    else suspects.push({ start: w.start, end: w.end });
  }

  // 2. Each decoded again; the most confident decode wins.
  let result = words;
  try {
    for (const [i, c] of suspects.entries()) {
      onProgress(`Checking for other languages... ${i + 1}/${suspects.length}`);
      const from = Math.max(0, c.start - 0.3);
      writeWav(clip, slice(pcm, from, c.end + 0.3));
      let others = mainLang === 'en' ? [] : ['en'];
      if (mainLang === 'en' && fs.existsSync(tools.tinyModel)) {
        const heard = await detect(tools, clip);
        if (heard && heard.lang !== 'en') others = FAMILIES.find((f) => f.includes(heard.lang)) ?? [heard.lang];
      }
      if (!others.length) continue;
      const main = await decode(tools, clip, mainLang);
      let best = main;
      for (const lang of others) {
        const other = await decode(tools, clip, lang);
        if (other.words.length && other.score > best.score + MARGIN) best = other;
      }
      if (best === main) continue;
      const moved = best.words.map((w) => ({ ...w, start: w.start + from, end: w.end + from }));
      result = [
        ...result.filter((w) => w.end <= c.start - 0.05 || w.start >= c.end + 0.05),
        ...moved,
      ].sort((a, b) => a.start - b.start);
    }
  } finally {
    fs.rmSync(clip, { force: true });
  }
  return result;
}
