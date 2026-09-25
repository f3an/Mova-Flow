import * as path from 'path';
import * as fs from 'fs';
import { execFile, spawn } from 'child_process';
import { downloadFile } from './download';
import { downloadGhcrArtifact } from './ghcr';

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
      zipPath = path.join(eDir, winAsset);
      const url = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_TAG}/${winAsset}`;
      onProgress(`Downloading recognition engine (${hasGpu ? 'GPU' : 'CPU'})...`);
      await downloadFile(url, zipPath, onDownloadProgress);
    }

    onProgress('Extracting recognition engine...');
    fs.mkdirSync(binDir(userDataDir), { recursive: true });
    await expandArchive(zipPath, binDir(userDataDir));
    fs.unlinkSync(zipPath);

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
    await downloadFile(url, mPath, (received, total) => {
      if (total > 0) onProgress(`Downloading model... ${Math.round((received / total) * 100)}%`);
    });
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

const SEGMENT_RE = /^\[(\d{2}):(\d{2}):(\d{2})\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}\]\s*(.*)$/;
// Not "lang = auto" from the "main: processing ..." line (that's just the -l flag
// echoed back, not a result) — the actual detection result is on its own line
// from whisper_full_with_state.
const LANG_RE = /auto-detected language:\s*(\w+)/i;

export interface TranscribeResult {
  text: string;
  detectedLanguage: string;
}

/** Spawns whisper-cli.exe as a child process (not a native binding — the same
 * lesson as the pip-worker hack in the Python version) and parses segments off
 * stdout as they stream in. */
export function transcribe(
  userDataDir: string,
  modelFilePath: string,
  filePath: string,
  language: string,
  onProgress: ProgressCb,
): Promise<TranscribeResult> {
  return new Promise((resolve, reject) => {
    // whisper-cli defaults to 'en' when -l is omitted — it does NOT auto-detect
    // by default — so auto mode needs an explicit '-l auto' or everything gets
    // forced through as English.
    const args = ['-m', modelFilePath, '-f', filePath, '-l', language || 'auto'];

    const exe = cliPath(userDataDir);
    const child = spawn(exe, args, { cwd: path.dirname(exe) });

    const lines: string[] = [];
    let detectedLanguage = language !== 'auto' ? language : '';
    let segmentCount = 0;
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
          const [, hh, mm, ss, segText] = m;
          const startSeconds = Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
          lines.push(`[${formatTimestamp(startSeconds)}] ${segText}`);
          segmentCount += 1;
          onProgress(`Processed segments: ${segmentCount}`);
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
      resolve({ text: lines.join('\n'), detectedLanguage: detectedLanguage || 'auto' });
    });
  });
}
