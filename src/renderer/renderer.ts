import { Lang, getLang, setLang, t } from './i18n';

interface ServerState {
  stage: 'stopped' | 'checking' | 'installing' | 'starting' | 'running' | 'error';
  message: string;
  port: number | null;
  error: string | null;
}

const MODEL_PRESETS = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'] as const;
type ModelPreset = (typeof MODEL_PRESETS)[number];

interface AppState {
  role: 'host' | 'client';
  host: string;
  port: number;
  lan_ip: string;
  server: ServerState;
  authSecret: string;
  clientSecret: string;
  language: Lang;
  modelPreset: ModelPreset;
  modelPath: string;
  lanExpose: boolean;
}

interface IssuedToken {
  token: string;
  expiresAt: number;
}

interface ClientHistoryEntry {
  id: string;
  filename: string;
  language: string;
  createdAt: number;
  audioExt: string;
}

interface WhisperApi {
  get_state(): Promise<AppState>;
  save_config(
    role: string,
    host: string,
    port: number,
    clientSecret: string,
    modelPreset: string,
    modelPath: string,
    lanExpose: boolean,
  ): Promise<{ ok: boolean }>;
  start_server(): Promise<{ ok: boolean }>;
  stop_server(): Promise<{ ok: boolean }>;
  check_remote(
    host: string,
    port: number,
    secret: string,
  ): Promise<{ reachable: boolean; authOk: boolean; error?: string }>;
  regenerate_secret(): Promise<{ secret: string }>;
  get_token(): Promise<IssuedToken>;
  set_language(lang: Lang): Promise<{ ok: boolean }>;
  choose_model_file(): Promise<{ path: string }>;
  save_client_history_entry(
    filename: string,
    language: string,
    audioExt: string,
    audioBytes: ArrayBuffer,
    text: string,
  ): Promise<{ entry: ClientHistoryEntry }>;
  get_client_history(): Promise<{ items: ClientHistoryEntry[] }>;
  get_client_history_text(id: string): Promise<{ text: string | null }>;
  get_client_history_audio(id: string): Promise<{ data: Uint8Array | null; ext: string | null }>;
  delete_client_history_entry(id: string): Promise<{ ok: boolean }>;
  get_update_state(): Promise<UpdateState>;
  install_update(): Promise<void>;
  open_releases_page(): Promise<void>;
  discover_hosts(): Promise<{ hosts: DiscoveredHost[] }>;
}

interface UpdateState {
  stage: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error';
  version: string | null;
  error: string | null;
}

interface DiscoveredHost {
  name: string;
  host: string;
  addresses: string[];
  port: number;
}

declare global {
  interface Window {
    api: WhisperApi;
    platform: string;
  }
}

// macOS draws the traffic-light buttons directly on top of the page (no room
// reserved automatically, unlike Windows' titleBarOverlay) — see trafficLightPosition
// in main/index.ts and the matching CSS rule this class enables.
if (window.platform === 'darwin') document.body.classList.add('platform-mac');

// ── Tabs ─────────────────────────────────────────────────────────────────
const tabbar = document.getElementById('tabbar') as HTMLDivElement;
const tabBtnTranscribe = document.getElementById('tabBtnTranscribe') as HTMLButtonElement;
const tabBtnHistory = document.getElementById('tabBtnHistory') as HTMLButtonElement;
const tabBtnServer = document.getElementById('tabBtnServer') as HTMLButtonElement;
const tabTranscribe = document.getElementById('tab-transcribe') as HTMLDivElement;
const tabHistory = document.getElementById('tab-history') as HTMLDivElement;
const tabServer = document.getElementById('tab-server') as HTMLDivElement;

function showTab(name: 'transcribe' | 'history' | 'server'): void {
  tabTranscribe.hidden = name !== 'transcribe';
  tabHistory.hidden = name !== 'history';
  tabServer.hidden = name !== 'server';
  tabBtnTranscribe.classList.toggle('active', name === 'transcribe');
  tabBtnHistory.classList.toggle('active', name === 'history');
  tabBtnServer.classList.toggle('active', name === 'server');
}
tabBtnTranscribe.addEventListener('click', () => showTab('transcribe'));
tabBtnHistory.addEventListener('click', () => {
  showTab('history');
  refreshHistoryTab();
});
tabBtnServer.addEventListener('click', () => {
  showTab('server');
  refreshServerTab();
});

// ── Sidebar collapse/expand ─────────────────────────────────────────────
// Pure per-device UI preference, so localStorage is the right home for it —
// no need to round-trip this through config.json/IPC.
const sideNav = document.getElementById('sideNav') as HTMLElement;
const navCollapseBtn = document.getElementById('navCollapseBtn') as HTMLButtonElement;

function applyNavCollapsed(collapsed: boolean): void {
  sideNav.classList.toggle('collapsed', collapsed);
  navCollapseBtn.textContent = collapsed ? '›' : '‹';
  navCollapseBtn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
}

navCollapseBtn.addEventListener('click', () => {
  const next = !sideNav.classList.contains('collapsed');
  applyNavCollapsed(next);
  try {
    localStorage.setItem('sideNavCollapsed', next ? '1' : '0');
  } catch {
    // Private window / blocked storage — collapsing still works, it just won't be remembered.
  }
});

(() => {
  let collapsed = false;
  try {
    collapsed = localStorage.getItem('sideNavCollapsed') === '1';
  } catch {
    collapsed = false;
  }
  applyNavCollapsed(collapsed);
})();

// ── Auth: the host mints its own token locally over IPC (the process already
// knows the secret); a client exchanges the pre-shared secret for a token via
// POST /api/auth. ──────────────────────────────────────────────────────────
let cachedToken: { base: string; token: string; expiresAt: number } | null = null;

async function ensureToken(base: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.base === base && cachedToken.expiresAt - 60 > now) {
    return cachedToken.token;
  }

  const state = await window.api.get_state();
  if (state.role === 'host') {
    const issued = await window.api.get_token();
    cachedToken = { base, token: issued.token, expiresAt: issued.expiresAt };
    return issued.token;
  }

  const res = await fetch(`${base}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: state.clientSecret || '' }),
  });
  if (!res.ok) throw new Error('AUTH_FAILED');
  const data = await res.json();
  cachedToken = { base, token: data.token, expiresAt: data.expiresAt };
  return data.token;
}

/** fetch() with automatic Bearer token injection; on 401 (expired token or a
 * changed secret) it drops the cache and retries exactly once. */
async function authorizedFetch(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  const withAuth = async (): Promise<Response> => {
    const token = await ensureToken(base);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(`${base}${path}`, { ...init, headers });
  };

  let res = await withAuth();
  if (res.status === 401) {
    cachedToken = null;
    res = await withAuth();
  }
  return res;
}

const BUSY_BANNER: Record<string, [string, string]> = {
  checking: ['banner.checking', 'Checking recognition components...'],
  installing: ['banner.installing', 'Installing recognition components...'],
  starting: ['banner.starting', 'Starting server...'],
};

/** null means "not reachable yet" — either the local host server hasn't
 * finished starting, or (for a client) there's simply no way to know without
 * a round trip, so that case is left to whatever calls fetch() to discover. */
function serverBaseUrl(state: AppState): string | null {
  return state.role === 'host'
    ? state.server.stage === 'running'
      ? `http://127.0.0.1:${state.server.port}`
      : null
    : `http://${state.host}:${state.port}`;
}

async function refreshTranscribeGate(): Promise<void> {
  const gate = document.getElementById('transcribeGate') as HTMLDivElement;
  const state = await window.api.get_state();
  const base = serverBaseUrl(state);

  if (base === null) {
    const busyEntry = BUSY_BANNER[state.server.stage];
    const message = busyEntry
      ? `${t(busyEntry[0], busyEntry[1])} ${escapeHtml(state.server.message || '')}`.trim()
      : t('banner.off', 'Server is off. Go to the Server tab and press Start.');
    gate.innerHTML = `<div class="banner">${message}</div>`;
    delete gate.dataset.built;
    return;
  }
  if (gate.dataset.built === base) return; // already built for this exact base
  gate.dataset.built = base;
  gate.innerHTML = `
    <div class="drop" id="drop" role="button" tabindex="0" aria-label="Choose an audio file">
      <input type="file" id="fileInput" accept=".mp3,.wav,.ogg,.flac,.m4a,.mov">
      <div class="drop-label">${t('drop.label', 'Drag an audio file here, or click to choose')}</div>
      <div class="drop-hint">mp3 · wav · ogg · flac · m4a · mov</div>
    </div>
    <div class="lang-row">
      <span>${t('transcribe.language', 'Language:')}</span>
      <select id="lang">
        <option value="auto">${t('transcribe.language.auto', 'Auto-detect')}</option>
        <option value="uk">${t('transcribe.language.uk', 'Ukrainian')}</option>
        <option value="en">English</option>
      </select>
    </div>
    <div id="jobs"></div>
  `;
  wireTranscribeUI(base);
}

// Formats whisper-cli can read directly (same list as ALLOWED_EXT on the
// server). Everything else gets converted to WAV right here, in the browser.
const NATIVE_EXTS = new Set(['.mp3', '.wav', '.ogg', '.flac']);

/** whisper-cli can't decode m4a/mov (its bundled miniaudio doesn't support
 * them), but Chromium inside Electron already knows how to parse these
 * containers via the Web Audio API — so we convert to WAV right here, with no
 * external binary to download. */
async function prepareFileForUpload(file: File): Promise<File> {
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  if (NATIVE_EXTS.has(ext)) return file;

  const arrayBuffer = await file.arrayBuffer();
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    decodeCtx.close();
  }

  // Resample to 16kHz mono — the exact WAV shape we've verified whisper-cli
  // reliably accepts.
  const targetRate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();

  const wavBlob = encodeWav(rendered);
  const baseName = dot >= 0 ? file.name.slice(0, dot) : file.name;
  return new File([wavBlob], `${baseName}.wav`, { type: 'audio/wav' });
}

/** Writes a minimal 16-bit PCM WAV (44-byte RIFF header) from a mono AudioBuffer. */
function encodeWav(buffer: AudioBuffer): Blob {
  const samples = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  const dataSize = samples.length * 2;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono, 16-bit)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([out], { type: 'audio/wav' });
}

function wireTranscribeUI(base: string): void {
  const drop = document.getElementById('drop') as HTMLDivElement;
  const fileInput = document.getElementById('fileInput') as HTMLInputElement;
  const jobsEl = document.getElementById('jobs') as HTMLDivElement;
  const langSelect = document.getElementById('lang') as HTMLSelectElement;

  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  ['dragenter', 'dragover'].forEach((evt) =>
    drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.add('drag');
    }),
  );
  ['dragleave', 'drop'].forEach((evt) =>
    drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.remove('drag');
    }),
  );
  drop.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files[0];
    if (file) uploadFile(file);
  });
  fileInput.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) uploadFile(file);
  });

  function createJobCard(filename: string): HTMLDivElement {
    const card = document.createElement('div');
    card.className = 'job';
    card.innerHTML = `
      <div class="job-head">
        <div class="job-name">${escapeHtml(filename)}</div>
        <div class="job-status status-queued">${t('job.queued', 'Queued')}</div>
      </div>
      <div class="bar-track"><div class="bar-fill"></div></div>
      <div class="progress-text">${t('job.uploading', 'Uploading file...')}</div>
    `;
    jobsEl.prepend(card);
    return card;
  }

  function renderError(card: HTMLDivElement, message: string): void {
    const statusEl = card.querySelector('.job-status') as HTMLDivElement;
    statusEl.textContent = t('job.error', 'Error');
    statusEl.className = 'job-status status-error';
    card.querySelector('.bar-track')?.remove();
    const progressEl = card.querySelector('.progress-text');
    if (progressEl) progressEl.outerHTML = `<div class="error-text">${escapeHtml(message)}</div>`;
  }

  async function uploadFile(file: File): Promise<void> {
    const jobCard = createJobCard(file.name);
    const progressEl = jobCard.querySelector('.progress-text');

    let uploadable: File;
    try {
      if (progressEl) progressEl.textContent = t('job.converting', 'Converting format...');
      uploadable = await prepareFileForUpload(file);
    } catch {
      renderError(jobCard, t('job.err.decode', 'Could not decode audio in this format.'));
      return;
    }

    const formData = new FormData();
    formData.append('file', uploadable);
    formData.append('language', langSelect.value);

    try {
      if (progressEl) progressEl.textContent = t('job.uploading', 'Uploading file...');
      const res = await authorizedFetch(base, '/api/transcribe', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.error) {
        renderError(jobCard, data.error);
        return;
      }
      pollStatus(data.job_id, jobCard, file);
    } catch {
      renderError(jobCard, t('job.err.unreachable', 'Could not reach the server.'));
    }
  }

  // A client's own submissions are never saved by the host (see requireLocal
  // in server.ts) — the only place left to keep "what I sent and what came
  // back" is here, locally, once the result is in. `file` is the original
  // pick, not the WAV `prepareFileForUpload` may have converted for upload,
  // so re-listening plays back exactly what the user recorded.
  async function saveToClientHistory(file: File, language: string, text: string): Promise<void> {
    const state = await window.api.get_state();
    if (state.role !== 'client') return;
    const dot = file.name.lastIndexOf('.');
    const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
    const audioBytes = await file.arrayBuffer();
    await window.api.save_client_history_entry(file.name, language, ext, audioBytes, text);
  }

  function pollStatus(jobId: string, card: HTMLDivElement, originalFile: File): void {
    const interval = setInterval(async () => {
      try {
        const res = await authorizedFetch(base, `/api/status/${jobId}`);
        const data = await res.json();

        if (data.error) {
          clearInterval(interval);
          renderError(card, data.error);
          return;
        }

        const statusEl = card.querySelector('.job-status') as HTMLDivElement;
        const progressEl = card.querySelector('.progress-text');

        if (data.status === 'processing') {
          statusEl.textContent = t('job.processing', 'Processing');
          statusEl.className = 'job-status status-processing';
          if (progressEl) progressEl.textContent = data.progress || '...';
        }

        if (data.status === 'done') {
          clearInterval(interval);
          statusEl.textContent = t('job.done', 'Done');
          statusEl.className = 'job-status status-done';
          card.querySelector('.bar-track')?.remove();

          const box = document.createElement('div');
          box.className = 'transcript-box';
          box.innerHTML = `
            <div class="transcript-text">${escapeHtml(data.result)}</div>
            <div class="actions">
              <button class="action" id="copyBtn">${t('job.copy', 'Copy')}</button>
              <button class="action secondary" id="downloadBtn">${t('job.download', 'Download .txt')}</button>
            </div>
          `;
          progressEl?.replaceWith(box);
          box.querySelector('#copyBtn')?.addEventListener('click', (e) => copyText(e.currentTarget as HTMLButtonElement));
          box.querySelector('#downloadBtn')?.addEventListener('click', () => downloadTranscript(base, jobId));
          void saveToClientHistory(originalFile, data.detectedLanguage || 'auto', data.result);
        }

        if (data.status === 'error') {
          clearInterval(interval);
          renderError(card, data.error || t('job.err.unknown', 'Unknown error'));
        }
      } catch {
        clearInterval(interval);
        renderError(card, t('job.err.lostConnection', 'Lost connection to the server'));
      }
    }, 1500);
  }
}

/** A plain <a href> can't carry an Authorization header, so the file is
 * fetched and handed to the browser as a blob link instead. */
async function downloadTranscript(base: string, jobId: string): Promise<void> {
  try {
    const res = await authorizedFetch(base, `/api/download/${jobId}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript_${jobId}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    // Silently ignored — a rare case, and the transcript stays visible on screen anyway.
  }
}

function copyText(btn: HTMLButtonElement): void {
  const text = btn.closest('.transcript-box')?.querySelector('.transcript-text')?.textContent || '';
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = t('job.copied', 'Copied');
    setTimeout(() => (btn.textContent = original), 1500);
  });
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── "History" tab ────────────────────────────────────────────────────────
interface HistoryItem {
  id: string;
  filename: string;
  language: string;
  createdAt: number;
  audioExt: string;
}

// The host keeps its own history over HTTP (and refuses it to anyone but
// itself — see requireLocal in server.ts); a client never gets to read that,
// so it keeps a parallel record of its own sent/received jobs locally via IPC
// (see clientHistory.ts). Both shapes are identical (HistoryItem); this just
// picks where the four operations go.
interface HistoryBackend {
  list(): Promise<HistoryItem[]>;
  text(id: string): Promise<string>;
  audioBlob(id: string, ext: string): Promise<Blob>;
  remove(id: string): Promise<void>;
}

function hostHistoryBackend(base: string): HistoryBackend {
  return {
    async list() {
      const res = await authorizedFetch(base, '/api/history');
      if (!res.ok) throw new Error('history unavailable');
      return (await res.json()).items || [];
    },
    async text(id) {
      const res = await authorizedFetch(base, `/api/history/${id}/text`);
      if (!res.ok) throw new Error('text unavailable');
      return (await res.json()).text || '';
    },
    async audioBlob(id) {
      const res = await authorizedFetch(base, `/api/history/${id}/audio`);
      if (!res.ok) throw new Error('audio unavailable');
      return res.blob();
    },
    async remove(id) {
      await authorizedFetch(base, `/api/history/${id}`, { method: 'DELETE' });
    },
  };
}

const CLIENT_AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mov': 'video/quicktime',
};

function clientHistoryBackend(): HistoryBackend {
  return {
    async list() {
      return (await window.api.get_client_history()).items;
    },
    async text(id) {
      const { text } = await window.api.get_client_history_text(id);
      if (text === null) throw new Error('text unavailable');
      return text;
    },
    async audioBlob(id, ext) {
      const { data } = await window.api.get_client_history_audio(id);
      if (!data) throw new Error('audio unavailable');
      return new Blob([data], { type: CLIENT_AUDIO_MIME[ext] || 'application/octet-stream' });
    },
    async remove(id) {
      await window.api.delete_client_history_entry(id);
    },
  };
}

function downloadTextAsFile(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function refreshHistoryTab(): Promise<void> {
  const gate = document.getElementById('historyGate') as HTMLDivElement;
  const state = await window.api.get_state();

  let backend: HistoryBackend;
  if (state.role === 'client') {
    backend = clientHistoryBackend();
  } else {
    const base = serverBaseUrl(state);
    if (base === null) {
      gate.innerHTML = `<div class="banner">${t('banner.off', 'Server is off. Go to the Server tab and press Start.')}</div>`;
      return;
    }
    backend = hostHistoryBackend(base);
  }

  let items: HistoryItem[];
  try {
    items = await backend.list();
  } catch {
    gate.innerHTML = `<div class="banner">${t('job.err.unreachable', 'Could not reach the server.')}</div>`;
    return;
  }

  if (items.length === 0) {
    gate.innerHTML = `<div class="banner">${t('history.empty', 'No transcriptions yet.')}</div>`;
    return;
  }

  gate.innerHTML = items.map((item) => historyCardHtml(item)).join('');
  gate.querySelectorAll<HTMLDivElement>('.job').forEach((card) => wireHistoryCard(card, backend));
}

function historyCardHtml(item: HistoryItem): string {
  const date = new Date(item.createdAt).toLocaleString();
  return `
    <div class="job" data-id="${item.id}" data-ext="${item.audioExt}">
      <div class="job-head">
        <div class="job-name">${escapeHtml(item.filename)}</div>
        <div class="job-status status-done">${escapeHtml(date)}</div>
      </div>
      <div class="progress-text">${t('history.language', 'Language: {lang}', { lang: item.language })}</div>
      <div class="history-audio"></div>
      <div class="actions">
        <button class="action secondary" data-action="play">${t('history.play', 'Play')}</button>
        <button class="action secondary" data-action="text">${t('history.viewText', 'View transcript')}</button>
        <button class="action secondary" data-action="download">${t('job.download', 'Download .txt')}</button>
        <button class="action danger" data-action="delete">${t('history.delete', 'Delete')}</button>
      </div>
      <div class="transcript-box" hidden></div>
    </div>
  `;
}

function buildAudioPlayer(container: HTMLElement, src: string): void {
  const audio = document.createElement('audio');
  audio.src = src;
  audio.controls = true;
  audio.autoplay = true;
  container.appendChild(audio);
}

function wireHistoryCard(card: HTMLDivElement, backend: HistoryBackend): void {
  const id = card.dataset.id!;
  const ext = card.dataset.ext!;
  const playBtn = card.querySelector('[data-action="play"]') as HTMLButtonElement;
  const textBtn = card.querySelector('[data-action="text"]') as HTMLButtonElement;
  const downloadBtn = card.querySelector('[data-action="download"]') as HTMLButtonElement;
  const deleteBtn = card.querySelector('[data-action="delete"]') as HTMLButtonElement;
  const audioSlot = card.querySelector('.history-audio') as HTMLDivElement;
  const textBox = card.querySelector('.transcript-box') as HTMLDivElement;

  playBtn.addEventListener('click', async () => {
    if (audioSlot.querySelector('.audio-player')) return;
    playBtn.disabled = true;
    playBtn.textContent = t('history.loading', 'Loading...');
    try {
      const blob = await backend.audioBlob(id, ext);
      buildAudioPlayer(audioSlot, URL.createObjectURL(blob));
      playBtn.remove();
    } catch {
      playBtn.disabled = false;
      playBtn.textContent = t('job.err.unreachable', 'Could not reach the server.');
    }
  });

  textBtn.addEventListener('click', async () => {
    if (!textBox.hidden) {
      textBox.hidden = true;
      textBtn.textContent = t('history.viewText', 'View transcript');
      return;
    }
    if (!textBox.dataset.loaded) {
      try {
        const text = await backend.text(id);
        textBox.innerHTML = `<div class="transcript-text">${escapeHtml(text)}</div>`;
        textBox.dataset.loaded = '1';
      } catch {
        textBox.innerHTML = `<div class="error-text">${t('job.err.unreachable', 'Could not reach the server.')}</div>`;
      }
    }
    textBox.hidden = false;
    textBtn.textContent = t('history.hideText', 'Hide transcript');
  });

  downloadBtn.addEventListener('click', async () => {
    try {
      const text = await backend.text(id);
      downloadTextAsFile(text, `transcript_${id}.txt`);
    } catch {
      // Nothing sensible to do — the button just stays clickable to retry.
    }
  });

  deleteBtn.addEventListener('click', async () => {
    const ok = confirm(t('history.delete.confirm', 'Delete this recording and its transcript? This cannot be undone.'));
    if (!ok) return;
    deleteBtn.disabled = true;
    try {
      await backend.remove(id);
      card.remove();
    } catch {
      deleteBtn.disabled = false;
    }
  });
}

// ── "Server" tab ─────────────────────────────────────────────────────────
const roleHost = document.getElementById('roleHost') as HTMLDivElement;
const roleClient = document.getElementById('roleClient') as HTMLDivElement;
const hostSection = document.getElementById('hostSection') as HTMLDivElement;
const clientSection = document.getElementById('clientSection') as HTMLDivElement;
const hostPortInput = document.getElementById('hostPortInput') as HTMLInputElement;
const clientHostInput = document.getElementById('clientHostInput') as HTMLInputElement;
const clientPortInput = document.getElementById('clientPortInput') as HTMLInputElement;
const srvBadge = document.getElementById('srvBadge') as HTMLSpanElement;
const srvToggleBtn = document.getElementById('srvToggleBtn') as HTMLButtonElement;
const srvMessage = document.getElementById('srvMessage') as HTMLDivElement;
const srvLanUrl = document.getElementById('srvLanUrl') as HTMLDivElement;
const clientSecretInput = document.getElementById('clientSecretInput') as HTMLInputElement;
const clientSaveBtn = document.getElementById('clientSaveBtn') as HTMLButtonElement;
const clientCheckBtn = document.getElementById('clientCheckBtn') as HTMLButtonElement;
const clientCheckResult = document.getElementById('clientCheckResult') as HTMLDivElement;
const scanNetworkBtn = document.getElementById('scanNetworkBtn') as HTMLButtonElement;
const scanResults = document.getElementById('scanResults') as HTMLDivElement;
const hostSecretInput = document.getElementById('hostSecretInput') as HTMLInputElement;
const copySecretBtn = document.getElementById('copySecretBtn') as HTMLButtonElement;
const regenSecretBtn = document.getElementById('regenSecretBtn') as HTMLButtonElement;
const langSwitch = document.getElementById('langSwitch') as HTMLSelectElement;
const modelSelect = document.getElementById('modelSelect') as HTMLSelectElement;
const modelPathInput = document.getElementById('modelPathInput') as HTMLInputElement;
const browseModelBtn = document.getElementById('browseModelBtn') as HTMLButtonElement;
const clearModelBtn = document.getElementById('clearModelBtn') as HTMLButtonElement;
const lanExposeCheckbox = document.getElementById('lanExposeCheckbox') as HTMLInputElement;

let uiRole: 'host' | 'client' = 'host';
let pollTimer: ReturnType<typeof setInterval> | null = null;

function selectRole(role: 'host' | 'client'): void {
  uiRole = role;
  roleHost.classList.toggle('selected', role === 'host');
  roleClient.classList.toggle('selected', role === 'client');
  hostSection.hidden = role !== 'host';
  clientSection.hidden = role !== 'client';
}
roleHost.addEventListener('click', () => selectRole('host'));
roleClient.addEventListener('click', () => selectRole('client'));

function setCustomModelPath(customPath: string): void {
  modelPathInput.value = customPath;
  clearModelBtn.hidden = !customPath;
  modelSelect.disabled = !!customPath;
}

browseModelBtn.addEventListener('click', async () => {
  const { path: chosen } = await window.api.choose_model_file();
  if (chosen) setCustomModelPath(chosen);
});

clearModelBtn.addEventListener('click', () => setCustomModelPath(''));

const SRV_LABELS: Record<string, [string, string, string]> = {
  stopped: ['srv.stopped', 'Stopped', 'status-queued'],
  checking: ['srv.checking', 'Checking...', 'status-processing'],
  installing: ['srv.installing', 'Installing...', 'status-processing'],
  starting: ['srv.starting', 'Starting...', 'status-processing'],
  running: ['srv.running', 'Running', 'status-done'],
  error: ['srv.error', 'Error', 'status-error'],
};

function renderServerState(state: AppState): void {
  const stage = state.server.stage;
  const [key, fallback, cls] = SRV_LABELS[stage] || SRV_LABELS.stopped;
  srvBadge.textContent = t(key, fallback);
  srvBadge.className = `job-status ${cls}`;
  srvMessage.textContent = stage === 'error' ? state.server.error || '' : state.server.message || '';

  const busy = stage === 'checking' || stage === 'installing' || stage === 'starting';
  srvToggleBtn.disabled = busy;
  srvToggleBtn.textContent = stage === 'running' ? t('srv.stop', 'Stop') : t('srv.start', 'Start');
  srvToggleBtn.className = stage === 'running' ? 'action danger' : 'action';
  hostPortInput.disabled = stage !== 'stopped' && stage !== 'error';

  if (stage === 'running' && state.server.port) {
    srvLanUrl.hidden = false;
    srvLanUrl.textContent = state.lanExpose
      ? t('srv.lanUrl', 'Available on the network: {url}', {
          url: `http://${state.lan_ip || '127.0.0.1'}:${state.server.port}`,
        })
      : t('srv.localOnly', 'Only available on this computer.');
  } else {
    srvLanUrl.hidden = true;
  }

  if (busy) {
    if (!pollTimer) pollTimer = setInterval(refreshServerTab, 800);
  } else if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function refreshServerTab(): Promise<void> {
  const state = await window.api.get_state();
  selectRole(uiRole || state.role);
  if (document.activeElement !== hostPortInput) hostPortInput.value = String(state.port);
  if (document.activeElement !== clientHostInput) clientHostInput.value = state.host;
  if (document.activeElement !== clientPortInput) clientPortInput.value = String(state.port);
  if (document.activeElement !== clientSecretInput) clientSecretInput.value = state.clientSecret || '';
  hostSecretInput.value = state.authSecret || '';
  modelSelect.value = state.modelPreset;
  setCustomModelPath(state.modelPath || '');
  lanExposeCheckbox.checked = state.lanExpose;
  renderServerState(state);
  refreshTranscribeGate();
}

srvToggleBtn.addEventListener('click', async () => {
  const state = await window.api.get_state();
  if (state.server.stage === 'running') {
    await window.api.stop_server();
  } else {
    // Pass along clientSecretInput.value so we don't accidentally wipe a
    // previously saved client secret when only the host settings change.
    await window.api.save_config(
      'host',
      '',
      Number(hostPortInput.value) || 5000,
      clientSecretInput.value,
      modelSelect.value,
      modelPathInput.value,
      lanExposeCheckbox.checked,
    );
    await window.api.start_server();
  }
  refreshServerTab();
});

clientSaveBtn.addEventListener('click', async () => {
  // A client doesn't use a model at all, but save_config always writes both
  // fields — pass the existing values through so switching to client and
  // saving doesn't wipe out a host model choice made earlier.
  const state = await window.api.get_state();
  await window.api.save_config(
    'client',
    clientHostInput.value,
    Number(clientPortInput.value) || 5000,
    clientSecretInput.value,
    state.modelPreset,
    state.modelPath,
    state.lanExpose,
  );
  cachedToken = null; // the secret may have changed — the old token is no longer guaranteed valid
  clientCheckResult.textContent = t('client.saved', 'Saved.');
  refreshServerTab();
});

clientCheckBtn.addEventListener('click', async () => {
  clientCheckResult.textContent = t('client.checking', 'Checking...');
  const res = await window.api.check_remote(
    clientHostInput.value,
    Number(clientPortInput.value) || 5000,
    clientSecretInput.value,
  );
  if (!res.reachable) {
    clientCheckResult.textContent = res.error
      ? t('client.unreachable.detail', 'Server not responding: {error}', { error: res.error })
      : t('client.unreachable', 'Server not responding.');
  } else if (!res.authOk) {
    clientCheckResult.textContent = t('client.badSecret', 'Connection OK, but the secret key is wrong.');
  } else {
    clientCheckResult.textContent = t('client.ok', 'Connection successful, authorization passed.');
  }
});

function hostInitial(name: string): string {
  return (name.trim()[0] || '?').toUpperCase();
}

scanNetworkBtn.addEventListener('click', async () => {
  scanNetworkBtn.disabled = true;
  scanNetworkBtn.textContent = t('client.scanning', 'Scanning...');
  scanResults.hidden = true;

  const { hosts } = await window.api.discover_hosts();

  scanNetworkBtn.disabled = false;
  scanNetworkBtn.textContent = '⟲ ' + t('client.scan', 'Scan network');

  if (hosts.length === 0) {
    scanResults.hidden = false;
    scanResults.innerHTML = `<div class="secret-hint" style="margin:0;">${t('client.scan.empty', 'Nothing found — enter the host manually below.')}</div>`;
    return;
  }

  scanResults.hidden = false;
  scanResults.innerHTML = hosts
    .map((h, i) => {
      const address = h.addresses[0] || h.host;
      return `
        <button type="button" class="host-card" data-index="${i}">
          <span class="host-icon">${escapeHtml(hostInitial(h.name))}</span>
          <span class="host-name">${escapeHtml(h.name)}</span>
          <span class="host-addr">${escapeHtml(address)}</span>
        </button>
      `;
    })
    .join('');

  scanResults.querySelectorAll<HTMLButtonElement>('.host-card').forEach((card) => {
    card.addEventListener('click', () => {
      const host = hosts[Number(card.dataset.index)];
      clientHostInput.value = host.addresses[0] || host.host;
      clientPortInput.value = String(host.port);
      clientCheckResult.textContent = '';
    });
  });
});

copySecretBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(hostSecretInput.value).then(() => {
    const original = copySecretBtn.textContent;
    copySecretBtn.textContent = t('job.copied', 'Copied');
    setTimeout(() => (copySecretBtn.textContent = original), 1500);
  });
});

regenSecretBtn.addEventListener('click', async () => {
  const ok = confirm(
    t(
      'secret.regen.confirm',
      'Regenerate the secret? Every client connected with the old key will lose access until it enters the new one.',
    ),
  );
  if (!ok) return;
  await window.api.regenerate_secret();
  cachedToken = null;
  refreshServerTab();
});

// ── Static translations: everything below is written in English directly in
// index.html, so this only has to run when the active language overrides it. ──
function applyStaticTranslations(lang: Lang): void {
  if (lang !== 'uk') return;

  const set = (id: string, key: string, fallback: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = t(key, fallback);
  };
  const setTooltip = (id: string, key: string, fallback: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const text = t(key, fallback);
    el.setAttribute('data-tooltip', text);
    el.setAttribute('aria-label', text);
  };

  set('brandSub', 'app.tagline', 'Local transcription, powered by Whisper');
  set('navLabelUpload', 'nav.upload', 'Upload');
  set('navLabelHistory', 'nav.history', 'History');
  set('navLabelServer', 'nav.server', 'Server');
  setTooltip('tabBtnTranscribe', 'nav.upload', 'Upload');
  setTooltip('tabBtnHistory', 'nav.history', 'History');
  setTooltip('tabBtnServer', 'nav.server', 'Server');
  set('langSwitchLabel', 'lang.switch.label', 'Language');
  set('historyTitle', 'history.title', 'History');
  set('serverTitle', 'server.title', 'Server');
  set('roleHostTitle', 'role.host.title', 'Server (host)');
  set('roleHostDesc', 'role.host.desc', 'This machine has a GPU and runs the transcription.');
  set('roleClientTitle', 'role.client.title', 'Client');
  set('roleClientDesc', 'role.client.desc', 'Interface only, connects to another machine on the network.');
  set('hostPortLabel', 'field.port', 'Port');
  set('clientPortLabel', 'field.port', 'Port');
  set('modelSelectLabel', 'model.select.label', 'Whisper model');
  set('modelSelectHint', 'model.select.hint', 'Larger models are more accurate but slower and take longer to download.');
  set('modelPathHint', 'model.path.hint', 'Or use your own model file instead of downloading one:');
  set('browseModelBtn', 'model.browse', 'Browse...');
  set('clearModelBtn', 'model.clear', 'Clear');
  modelPathInput.placeholder = t('model.path.placeholder', 'No file selected');
  set('lanExposeLabel', 'lan.expose.label', 'Expose to local network');
  set('lanExposeHint', 'lan.expose.hint', 'Lets other devices on your network connect to this server. Turn off to only use it on this computer.');
  set('secretLabel', 'secret.label', 'Access secret key');
  set(
    'secretHint',
    'secret.hint',
    'Required on every client device so it can connect to this server over the network. Without it, the transcription API is inaccessible to anyone.',
  );
  set('copySecretBtn', 'secret.copy', 'Copy');
  set('regenSecretBtn', 'secret.regen', 'Generate new');
  set('clientHostLabel', 'client.host.label', 'Server IP address');
  set('clientSecretLabel', 'client.secret.label', 'Secret key (from the Server tab on the host machine)');
  set('clientSaveBtn', 'client.save', 'Save');
  set('clientCheckBtn', 'client.check', 'Test connection');
  const scanBtnEl = document.getElementById('scanNetworkBtn');
  if (scanBtnEl) scanBtnEl.textContent = '⟲ ' + t('client.scan', 'Scan network');
  set('scanHint', 'client.scan.hint', 'Finds hosts with "Expose to local network" turned on.');

  const clientSecret = document.getElementById('clientSecretInput') as HTMLInputElement | null;
  if (clientSecret) clientSecret.placeholder = t('client.secret.placeholder', 'secret key');
}

langSwitch.addEventListener('change', async () => {
  const next = langSwitch.value as Lang;
  await window.api.set_language(next);
  // A full reload is the simplest way to re-render every dynamically built
  // string (job cards, banners, etc.) in the new language.
  location.reload();
});

// ── Init ─────────────────────────────────────────────────────────────────
// ── Update banner ───────────────────────────────────────────────────────
const updateBanner = document.getElementById('updateBanner') as HTMLDivElement;

async function refreshUpdateBanner(): Promise<void> {
  const state = await window.api.get_update_state();

  // 'available' only reaches here on macOS — Windows/Linux go straight from
  // available to downloading without user-visible interruption (see
  // initAutoUpdater() in main/index.ts), so there's nothing to show them
  // until the update is actually ready to install.
  if (state.stage === 'downloaded') {
    updateBanner.hidden = false;
    updateBanner.innerHTML = `
      <span>${t('update.downloaded', 'Mova Flow {version} is ready.', { version: state.version || '' })}</span>
      <button class="action" id="updateInstallBtn">${t('update.restart', 'Restart to update')}</button>
    `;
    document.getElementById('updateInstallBtn')?.addEventListener('click', () => window.api.install_update());
  } else if (state.stage === 'available' && window.platform === 'darwin') {
    updateBanner.hidden = false;
    updateBanner.innerHTML = `
      <span>${t('update.available', 'Mova Flow {version} is available.', { version: state.version || '' })}</span>
      <button class="action secondary" id="updateDownloadBtn">${t('update.download', 'Download')}</button>
    `;
    document.getElementById('updateDownloadBtn')?.addEventListener('click', () => window.api.open_releases_page());
  } else {
    updateBanner.hidden = true;
  }
}

async function init(): Promise<void> {
  const state = await window.api.get_state();
  uiRole = state.role;
  setLang(state.language || 'en');
  langSwitch.value = getLang();
  applyStaticTranslations(getLang());
  document.title = 'Mova Flow';
  showTab('transcribe');
  refreshServerTab();
  refreshUpdateBanner();
  setInterval(refreshUpdateBanner, 30_000);
}
void tabbar; // tabbar is always visible in Electron, unlike the Python version
             // which hid it until window.pywebview appeared
init();
