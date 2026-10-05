import { Lang, getLang, setLang, t } from './i18n';
import { CallRecorder } from './callRecorder';
import { CaptureSource, pickCaptureSource } from './sourcePicker';

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
  autoUpdate: boolean;
  appVersion: string;
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
  set_client_history_text(id: string, text: string): Promise<{ ok: boolean }>;
  delete_client_history_entry(id: string): Promise<{ ok: boolean }>;
  recording_begin(name: string): Promise<{ id: string }>;
  recording_append(id: string, side: 'me' | 'call', startedAt: number, pcm: ArrayBuffer): Promise<void>;
  recording_finish(id: string): Promise<PendingRecording | null>;
  list_recordings(): Promise<{ items: PendingRecording[] }>;
  read_recording(id: string): Promise<{ data: Uint8Array | null; speakerTimeline: string | null }>;
  show_recording(id: string): Promise<void>;
  delete_recording(id: string): Promise<{ ok: boolean }>;
  get_vocabulary(): Promise<{ vocabulary: Vocabulary; useHost: boolean }>;
  save_vocabulary(vocabulary: Vocabulary, useHost: boolean): Promise<{ vocabulary: Vocabulary }>;
  get_update_state(): Promise<UpdateState>;
  install_update(): Promise<void>;
  download_update(): Promise<void>;
  set_auto_update(enabled: boolean): Promise<{ ok: boolean }>;
  on_update_state(callback: (state: UpdateState) => void): void;
  discover_hosts(): Promise<{ hosts: DiscoveredHost[] }>;
  ensure_microphone_access(): Promise<boolean>;
  system_audio_sources(): Promise<CaptureSource[]>;
  system_audio_start(recordingId: string, appBundleId?: string): Promise<{ startedAt: number }>;
  set_recording_indicator(recording: boolean): Promise<void>;
  on_tray_toggle_recording(callback: () => void): void;
  on_system_audio_level(callback: (level: number) => void): void;
  check_for_updates(): Promise<UpdateState>;
}

/** A call recording saved on this computer and not transcribed yet (see
 * main/recordings.ts). */
interface PendingRecording {
  id: string;
  name: string;
  createdAt: number;
  state: 'recording' | 'ready';
  interrupted: boolean;
  size: number;
  seconds: number;
}

/** See main/vocabulary.ts. */
interface Vocabulary {
  terms: string[];
  replacements: [string, string][];
}

interface UpdateState {
  stage: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error';
  version: string | null;
  error: string | null;
  percent: number;
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
const tabBtnRecord = document.getElementById('tabBtnRecord') as HTMLButtonElement;
const tabBtnSettings = document.getElementById('tabBtnSettings') as HTMLButtonElement;

type TabName = 'transcribe' | 'record' | 'history' | 'server' | 'settings';
const TABS: Record<TabName, [HTMLButtonElement, HTMLDivElement]> = {
  transcribe: [tabBtnTranscribe, document.getElementById('tab-transcribe') as HTMLDivElement],
  record: [tabBtnRecord, document.getElementById('tab-record') as HTMLDivElement],
  history: [tabBtnHistory, document.getElementById('tab-history') as HTMLDivElement],
  server: [tabBtnServer, document.getElementById('tab-server') as HTMLDivElement],
  settings: [tabBtnSettings, document.getElementById('tab-settings') as HTMLDivElement],
};

function showTab(name: TabName): void {
  for (const [tab, [button, panel]] of Object.entries(TABS) as [TabName, [HTMLButtonElement, HTMLDivElement]][]) {
    panel.hidden = tab !== name;
    button.classList.toggle('active', tab === name);
  }
}
tabBtnTranscribe.addEventListener('click', () => showTab('transcribe'));
tabBtnRecord.addEventListener('click', () => showTab('record'));
tabBtnSettings.addEventListener('click', () => {
  showTab('settings');
  void refreshMics();
  void window.api.get_state().then((state) => loadVocabulary(state.role));
});
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

const LANGUAGE_SELECT = (id: string) => `
    <div class="lang-row">
      <span>${t('transcribe.language', 'Language:')}</span>
      <select id="${id}">
        <option value="auto">${t('transcribe.language.auto', 'Auto-detect')}</option>
        <option value="uk">${t('transcribe.language.uk', 'Ukrainian')}</option>
        <option value="en">English</option>
      </select>
    </div>`;

/** Upload and Record both need a reachable server; until there is one they
 * show the same banner saying why. Each is built once per server address —
 * Record never mid-call, which would throw the running recorder away. */
async function refreshTranscribeGate(): Promise<void> {
  const state = await window.api.get_state();
  const base = serverBaseUrl(state);
  const gates = [
    { el: document.getElementById('transcribeGate') as HTMLDivElement, build: buildUploadGate },
    { el: document.getElementById('recordGate') as HTMLDivElement, build: buildRecordGate },
  ];
  for (const { el, build } of gates) {
    if (el.id === 'recordGate' && callRecordingActive) continue;
    if (base === null) {
      const busyEntry = BUSY_BANNER[state.server.stage];
      const message = busyEntry
        ? `${t(busyEntry[0], busyEntry[1])} ${escapeHtml(state.server.message || '')}`.trim()
        : t('banner.off', 'Server is off. Go to the Server tab and press Start.');
      el.innerHTML = `<div class="banner">${message}</div>`;
      delete el.dataset.built;
      if (el.id === 'recordGate') recordUpload = null;
      continue;
    }
    if (el.dataset.built === base) continue; // already built for this exact base
    el.dataset.built = base;
    build(el, base);
  }
}

function buildUploadGate(gate: HTMLDivElement, base: string): void {
  gate.innerHTML = `
    <div class="drop" id="drop" role="button" tabindex="0" aria-label="Choose an audio file">
      <input type="file" id="fileInput" accept=".mp3,.wav,.ogg,.flac,.m4a,.mov">
      <div class="drop-label">${t('drop.label', 'Drag an audio file here, or click to choose')}</div>
      <div class="drop-hint">mp3 · wav · ogg · flac · m4a · mov</div>
    </div>
    ${LANGUAGE_SELECT('lang')}
    <div id="jobs"></div>
  `;
  wireTranscribeUI(base);
}

function buildRecordGate(gate: HTMLDivElement, base: string): void {
  gate.innerHTML = `
    <div class="rec-panel" id="recPanel">
      <div class="rec-head">
        <button class="action" id="recBtn">● ${t('rec.start', 'Record a call')}</button>
        <span class="rec-source" id="recSource" hidden></span>
        <span class="rec-timer" id="recTimer" hidden>00:00</span>
      </div>
      <p class="rec-mic-line" id="recMicLine"></p>
      <div class="rec-meters" id="recMeters" hidden>
        <div class="rec-meter"><span>${t('rec.me', 'Me')}</span><div class="meter-track"><div class="meter-fill" id="meterMe"></div></div></div>
        <div class="rec-meter"><span>${t('rec.call', 'Call')}</span><div class="meter-track"><div class="meter-fill" id="meterCall"></div></div></div>
      </div>
      <p class="rec-hint" id="recHint">${t(
        'rec.hint',
        'Records your microphone and everything this computer plays — a Zoom, Teams or Telegram call — and marks who said what. Headphones give the cleanest split.',
      )}</p>
    </div>
    ${LANGUAGE_SELECT('recLang')}
    <div id="recJobs"></div>
  `;
  recordUpload = makeUploader(
    base,
    document.getElementById('recJobs') as HTMLDivElement,
    document.getElementById('recLang') as HTMLSelectElement,
  );
  wireCallRecorder();
}

/** Uploads into the Record tab's job list; null while that tab shows a
 * banner instead (server off, host unreachable). */
let recordUpload: ((file: File, options?: UploadOptions) => Promise<void>) | null = null;

/** Sends a saved recording (see main/recordings.ts) for transcription and
 * shows its progress on the Record tab. */
async function transcribeSavedRecording(id: string, name: string): Promise<void> {
  showTab('record');
  if (!recordUpload) return; // the tab's banner says why
  const { data, speakerTimeline } = await window.api.read_recording(id);
  if (!data) return;
  void recordUpload(new File([data as BlobPart], name, { type: 'audio/wav' }), {
    speakers: 'me-others',
    recordingId: id,
    speakerTimeline: speakerTimeline ?? undefined,
  });
}

// ── Record a call ────────────────────────────────────────────────────────
// System-audio levels on macOS come from the main process (the capture
// helper), so they're routed to whichever recorder is currently running.
let activeCallLevel: ((level: number) => void) | null = null;
window.api.on_system_audio_level((level) => activeCallLevel?.(level));

// The tray's Record / Stop item presses the same button. If the Upload tab
// isn't built yet (server off, host unreachable), showing it is the answer —
// its banner says why recording isn't available.
let toggleCallRecording: (() => void) | null = null;
let callRecordingActive = false;
window.api.on_tray_toggle_recording(() => {
  showTab('record');
  toggleCallRecording?.();
});

// ── Microphone (Settings → Recording) ────────────────────────────────────
// Which microphone records the user — remembered between recordings.
// Chromium labels inputs with their transport ("AirPods (Bluetooth)"),
// which is how a Bluetooth mic gets its headset-mode warning.
const MIC_KEY = 'movaFlowCallMic';
const micSelect = document.getElementById('recMic') as HTMLSelectElement;
const micNote = document.getElementById('recMicNote') as HTMLParagraphElement;
const isBluetooth = (label: string) => /\(bluetooth\)|airpods/i.test(label);

function chosenMicLabel(): string {
  return micSelect.selectedOptions[0]?.dataset.label || '';
}

function updateMicNote(): void {
  micNote.hidden = !isBluetooth(chosenMicLabel());
  const line = document.getElementById('recMicLine');
  if (line) {
    line.innerHTML = `${t('rec.mic', 'Microphone')}: <strong>${escapeHtml(chosenMicLabel() || t('rec.mic.default', 'System default'))}</strong> · <a href="#" id="recMicChange">${t('rec.mic.change', 'change')}</a>${
      isBluetooth(chosenMicLabel()) ? ` <span class="rec-mic-warn">${t('rec.mic.headset', '— headphones go into headset mode')}</span>` : ''
    }`;
    document.getElementById('recMicChange')?.addEventListener('click', (e) => {
      e.preventDefault();
      showTab('settings');
      void refreshMics();
    });
  }
}

async function refreshMics(): Promise<void> {
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  // Chromium's own aliases for the system default / Windows communications device.
  const aliases = new Set(['default', 'communications']);
  const defaultLabel = inputs.find((d) => d.deviceId === 'default')?.label.replace(/^Default - /, '') ?? '';
  const saved = localStorage.getItem(MIC_KEY) ?? '';
  micSelect.innerHTML =
    `<option value="" data-label="${escapeHtml(defaultLabel)}">${escapeHtml(
      defaultLabel ? t('rec.mic.defaultNamed', 'System default ({name})', { name: defaultLabel }) : t('rec.mic.default', 'System default'),
    )}</option>` +
    inputs
      .filter((d) => !aliases.has(d.deviceId))
      .map((d, i) => {
        const label = d.label || `${t('rec.mic', 'Microphone')} ${i + 1}`;
        return `<option value="${escapeHtml(d.deviceId)}" data-label="${escapeHtml(label)}">${escapeHtml(label)}</option>`;
      })
      .join('');
  micSelect.value = [...micSelect.options].some((o) => o.value === saved) ? saved : '';
  updateMicNote();
}
navigator.mediaDevices.addEventListener('devicechange', () => void refreshMics());
micSelect.addEventListener('change', () => {
  localStorage.setItem(MIC_KEY, micSelect.value);
  updateMicNote();
});

/** "2026-10-05 14-01" in the computer's own time zone. */
function localStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
}

function wireCallRecorder(): void {
  const recBtn = document.getElementById('recBtn') as HTMLButtonElement;
  const timer = document.getElementById('recTimer') as HTMLSpanElement;
  const meters = document.getElementById('recMeters') as HTMLDivElement;
  const hint = document.getElementById('recHint') as HTMLParagraphElement;
  const meterMe = document.getElementById('meterMe') as HTMLDivElement;
  const meterCall = document.getElementById('meterCall') as HTMLDivElement;
  const sourceLabel = document.getElementById('recSource') as HTMLSpanElement;
  const hintText = hint.textContent || '';
  toggleCallRecording = () => {
    if (!recBtn.disabled) recBtn.click();
  };

  void refreshMics();

  // Speech RMS rarely goes past ~0.3; scale so normal talking fills most of the bar.
  const showLevel = (meter: HTMLDivElement, level: number) => {
    meter.style.width = `${Math.min(100, Math.round(Math.sqrt(level) * 180))}%`;
  };
  const recorder = new CallRecorder(window.api, window.platform, (side, level) =>
    showLevel(side === 'me' ? meterMe : meterCall, level),
  );

  let startedAt = 0;
  let tick: ReturnType<typeof setInterval> | null = null;
  const setIdle = () => {
    if (tick) clearInterval(tick);
    tick = null;
    activeCallLevel = null;
    void window.api.set_recording_indicator(false);
    sourceLabel.hidden = true;
    micSelect.disabled = false;
    callRecordingActive = false;
    langSwitch.disabled = false;
    langSwitchBusy.hidden = true;
    recBtn.disabled = false;
    recBtn.classList.remove('danger');
    recBtn.textContent = `● ${t('rec.start', 'Record a call')}`;
    timer.hidden = true;
    meters.hidden = true;
    showLevel(meterMe, 0);
    showLevel(meterCall, 0);
  };

  recBtn.addEventListener('click', async () => {
    if (tick) {
      recBtn.disabled = true;
      recBtn.textContent = t('rec.stopping', 'Stopping...');
      try {
        const saved = await recorder.stop();
        if (saved) await transcribeSavedRecording(saved.id, saved.name);
        else showTab('history'); // couldn't be assembled now — History retries
      } finally {
        setIdle();
      }
      return;
    }

    // macOS can record one app instead of everything (Windows loopback can't),
    // so ask where the call is first.
    let source = '';
    let sourceName = '';
    if (window.platform === 'darwin') {
      let sources: CaptureSource[] = [];
      const choice = await pickCaptureSource(async () => (sources = await window.api.system_audio_sources()), t);
      if (choice === null) return;
      source = choice;
      sourceName = sources.find((s) => s.bundleId === choice)?.name ?? '';
    }

    recBtn.disabled = true;
    recBtn.textContent = t('rec.starting', 'Starting...');
    hint.textContent = hintText;
    hint.classList.remove('error-text');
    activeCallLevel = (level) => showLevel(meterCall, level);
    try {
      await recorder.start(`Call ${localStamp(Date.now())}.wav`, source || undefined, micSelect.value || undefined);
    } catch (err) {
      setIdle();
      // IPC errors arrive as "Error invoking remote method '…': Error: <message>".
      const message = ((err as Error).message || '').replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
      hint.textContent = message || t('rec.err.start', "Couldn't start recording.");
      hint.classList.add('error-text');
      return;
    }
    startedAt = Date.now();
    void window.api.set_recording_indicator(true);
    micSelect.disabled = true;
    callRecordingActive = true;
    // Changing the language reloads the page, which would end the recording.
    langSwitch.disabled = true;
    langSwitchBusy.hidden = false;
    sourceLabel.textContent = sourceName
      ? t('rec.from', 'from {name}', { name: sourceName })
      : window.platform === 'darwin'
        ? t('rec.from.all', 'all system audio')
        : '';
    sourceLabel.hidden = !sourceLabel.textContent;
    recBtn.disabled = false;
    recBtn.classList.add('danger');
    recBtn.textContent = `■ ${t('rec.stop', 'Stop & transcribe')}`;
    timer.hidden = false;
    meters.hidden = false;
    const pad = (n: number) => String(n).padStart(2, '0');
    const render = () => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      timer.textContent = `${s >= 3600 ? `${Math.floor(s / 3600)}:` : ''}${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
    };
    render();
    tick = setInterval(render, 1000);
  });
}

// Formats whisper-cli can read directly (same list as ALLOWED_EXT on the
// server). Everything else gets converted to WAV right here, in the browser.
// Only WAV goes up as it is: the host reads WAV itself to check for speech
// in other languages (main/mixedLanguage.ts); everything else becomes one.
const NATIVE_EXTS = new Set(['.wav']);

/** whisper-cli can't decode m4a/mov (its bundled miniaudio doesn't support
 * them), but Chromium inside Electron already knows how to parse these
 * containers via the Web Audio API — so we convert to WAV right here, with no
 * external binary to download. */
async function prepareFileForUpload(file: File): Promise<File> {
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  if (NATIVE_EXTS.has(ext)) return file;

  // Decoded straight at 16 kHz: an hour of 48 kHz stereo would otherwise
  // take over a gigabyte as float samples before it's resampled.
  const arrayBuffer = await file.arrayBuffer();
  const decoded = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(arrayBuffer);

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

  const uploadFile = makeUploader(base, jobsEl, langSelect);
}

interface UploadOptions {
  /** A stereo recording with the user on the left channel and the call on
   * the right — the host labels lines Me / Others. */
  speakers?: 'me-others';
  /** The saved call recording this is (see main/recordings.ts): it's kept
   * until the transcript is in history, so a failed upload never loses it. */
  recordingId?: string;
  /** JSON speaker turns (Meet captions, via the extension) — see speaker_timeline in docs/API.md. */
  speakerTimeline?: string;
}

// Saved recordings currently being sent or transcribed — History shows them
// as such instead of offering Transcribe again.
const recordingsInFlight = new Set<string>();

// A host answering 429 is busy, not broken: wait the limiter window out
// rather than fail (an upload is the one request that must get through).
const BUSY_RETRY_MS = 20_000;
const BUSY_GIVE_UP_MS = 6 * 60_000;
const POLL_MS = 2_000;
// Status polls that fail (Wi-Fi blip, host restarting, 429) are retried for
// this long before the card gives up.
const POLL_GIVE_UP_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Uploads a file to `base` for transcription and tracks it as a job card
 * in `jobsEl` until the transcript is in. Shared by Upload (files) and Record
 * (call recordings, with speakers=me-others). Any failure leaves a Retry
 * button on the card. */
function makeUploader(
  base: string,
  jobsEl: HTMLDivElement,
  langSelect: HTMLSelectElement,
): (file: File, options?: UploadOptions) => Promise<void> {
  return uploadFile;

  function createJobCard(filename: string, before?: HTMLDivElement): HTMLDivElement {
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
    if (before) before.replaceWith(card);
    else jobsEl.prepend(card);
    return card;
  }

  function renderError(card: HTMLDivElement, message: string, file: File, options: UploadOptions): void {
    if (options.recordingId) recordingsInFlight.delete(options.recordingId);
    const statusEl = card.querySelector('.job-status') as HTMLDivElement;
    statusEl.textContent = t('job.error', 'Error');
    statusEl.className = 'job-status status-error';
    card.querySelector('.bar-track')?.remove();
    const progressEl = card.querySelector('.progress-text');
    const saved = options.recordingId
      ? `<div class="job-saved">${t('job.savedRecording', 'The recording is saved — it waits in History until it is transcribed.')}</div>`
      : '';
    const html = `<div class="error-text">${escapeHtml(message)}</div>${saved}
      <div class="actions">
        <button class="action" data-act="retry">${t('job.retry', 'Try again')}</button>
        ${options.recordingId ? `<button class="action secondary" data-act="show">${t('job.showFile', 'Show file')}</button>` : ''}
      </div>`;
    if (progressEl) progressEl.outerHTML = html;
    else card.insertAdjacentHTML('beforeend', html);
    card.querySelector('[data-act="retry"]')?.addEventListener('click', () => void uploadFile(file, options, card));
    card.querySelector('[data-act="show"]')?.addEventListener('click', () => {
      if (options.recordingId) void window.api.show_recording(options.recordingId);
    });
  }

  async function uploadFile(file: File, options: UploadOptions = {}, replaceCard?: HTMLDivElement): Promise<void> {
    const jobCard = createJobCard(file.name, replaceCard);
    const progressEl = jobCard.querySelector('.progress-text');
    if (options.recordingId) recordingsInFlight.add(options.recordingId);

    let uploadable: File;
    try {
      if (progressEl) progressEl.textContent = t('job.converting', 'Converting format...');
      uploadable = await prepareFileForUpload(file);
    } catch {
      renderError(jobCard, t('job.err.decode', 'Could not decode audio in this format.'), file, options);
      return;
    }

    const formData = new FormData();
    formData.append('file', uploadable);
    formData.append('language', langSelect.value);
    if (options.speakers) formData.append('speakers', options.speakers);
    if (options.speakerTimeline) formData.append('speaker_timeline', options.speakerTimeline);
    try {
      const { vocabulary, useHost } = await window.api.get_vocabulary();
      formData.append('vocabulary', JSON.stringify(vocabulary));
      if (!useHost) formData.append('host_vocabulary', '0');
    } catch {
      // no vocabulary — transcribed without one
    }

    try {
      for (let waited = 0; ; waited += BUSY_RETRY_MS) {
        if (progressEl) progressEl.textContent = t('job.uploading', 'Uploading file...');
        const res = await authorizedFetch(base, '/api/transcribe', { method: 'POST', body: formData });
        if (res.status === 429 && waited < BUSY_GIVE_UP_MS) {
          if (progressEl) progressEl.textContent = t('job.busyRetry', 'The server is busy — trying again shortly...');
          await sleep(BUSY_RETRY_MS);
          continue;
        }
        const data = await res.json();
        if (data.error) {
          renderError(jobCard, data.error, file, options);
          return;
        }
        pollStatus(data.job_id, jobCard, file, options);
        return;
      }
    } catch {
      renderError(jobCard, t('job.err.unreachable', 'Could not reach the server.'), file, options);
    }
  }

  // A client's own submissions are never saved by the host (see requireLocal
  // in server.ts) — the only place left to keep "what I sent and what came
  // back" is here, locally, once the result is in. `file` is the original
  // pick, not the WAV `prepareFileForUpload` may have converted for upload,
  // so re-listening plays back exactly what the user recorded.
  /** Returns where the transcript is now kept: the client history entry's
   * id, or null on a host (its own history entry is the job id). */
  async function saveToClientHistory(file: File, language: string, text: string): Promise<string | null> {
    const state = await window.api.get_state();
    if (state.role !== 'client') return null;
    const dot = file.name.lastIndexOf('.');
    const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
    const audioBytes = await file.arrayBuffer();
    return (await window.api.save_client_history_entry(file.name, language, ext, audioBytes, text)).entry.id;
  }

  /** The recording is in history now (the host keeps its own copy; a client
   * just saved one) — the safety copy can go. Resolves with a function that
   * saves a corrected transcript over that history entry. */
  async function finishSaved(
    jobId: string,
    file: File,
    language: string,
    text: string,
    options: UploadOptions,
  ): Promise<(text: string) => Promise<void>> {
    let clientId: string | null;
    try {
      clientId = await saveToClientHistory(file, language, text);
    } catch {
      return async () => {}; // not in history — keep the safety copy
    }
    if (options.recordingId) {
      recordingsInFlight.delete(options.recordingId);
      await window.api.delete_recording(options.recordingId);
    }
    if (clientId) return async (fixed) => void (await window.api.set_client_history_text(clientId!, fixed));
    return async (fixed) =>
      void (await authorizedFetch(base, `/api/history/${jobId}/text`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: fixed }),
      }));
  }

  function pollStatus(jobId: string, card: HTMLDivElement, originalFile: File, options: UploadOptions): void {
    let failingSince = 0;
    const statusEl = card.querySelector('.job-status') as HTMLDivElement;
    const progressEl = card.querySelector('.progress-text');

    const tick = async (): Promise<void> => {
      let data: { status?: string; progress?: string; result?: string; detectedLanguage?: string; error?: string };
      try {
        const res = await authorizedFetch(base, `/api/status/${jobId}`);
        // Busy or briefly unreachable: keep asking. 404 is final — the host
        // restarted and forgot the job.
        if (res.status === 429 || res.status >= 500) throw new Error(String(res.status));
        data = await res.json();
      } catch {
        if (!failingSince) failingSince = Date.now();
        if (Date.now() - failingSince > POLL_GIVE_UP_MS) {
          renderError(card, t('job.err.lostConnection', 'Lost connection to the server'), originalFile, options);
          return;
        }
        setTimeout(tick, POLL_MS);
        return;
      }
      failingSince = 0;

      if (data.error && data.status !== 'error') {
        renderError(card, data.error, originalFile, options);
        return;
      }

      if (data.status === 'processing') {
        statusEl.textContent = t('job.processing', 'Processing');
        statusEl.className = 'job-status status-processing';
        if (progressEl) progressEl.textContent = data.progress || '...';
      }

      if (data.status === 'done') {
        statusEl.textContent = t('job.done', 'Done');
        statusEl.className = 'job-status status-done';
        card.querySelector('.bar-track')?.remove();

        const box = document.createElement('div');
        box.className = 'transcript-box';
        box.innerHTML = `
          <div class="transcript-text">${escapeHtml(data.result || '')}</div>
          <div class="actions">
            <button class="action" id="copyBtn">${t('job.copy', 'Copy')}</button>
            <button class="action secondary" id="downloadBtn">${t('job.download', 'Download .txt')}</button>
          </div>
        `;
        progressEl?.replaceWith(box);
        const textEl = box.querySelector('.transcript-text') as HTMLDivElement;
        box.querySelector('#copyBtn')?.addEventListener('click', (e) => copyText(e.currentTarget as HTMLButtonElement));
        // What's on screen, corrections included.
        box.querySelector('#downloadBtn')?.addEventListener('click', () =>
          downloadTextAsFile(textEl.textContent || '', `transcript_${jobId}.txt`),
        );
        const saved = finishSaved(jobId, originalFile, data.detectedLanguage || 'auto', data.result || '', options);
        makeCorrectable(textEl, async (fixed) => (await saved)(fixed));
        return;
      }

      if (data.status === 'error') {
        renderError(card, data.error || t('job.err.unknown', 'Unknown error'), originalFile, options);
        return;
      }
      setTimeout(tick, POLL_MS);
    };
    setTimeout(tick, POLL_MS);
  }
}

// ── Correcting a transcript ──────────────────────────────────────────────
// Double-click a word or select a phrase in a transcript to fix it: every
// occurrence in that transcript changes, the transcript is saved over its
// history entry, and — "Remember" ticked — the fix goes into the
// vocabulary (as heard → as it should be, plus the right spelling as a
// term), so the next recordings get it right. Whisper's own confidence
// can't point at the mistakes: on a real interview it was sure of
// "Async/Evade" and unsure of words it got right.

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole words only, ignoring case — the same rule the host uses for the
 * vocabulary's replacements (main/vocabulary.ts). */
function replaceWholeWords(text: string, from: string, to: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(from)}(?![\\p{L}\\p{N}])`, 'giu'), () => {
    count++;
    return to;
  });
  return { text: out, count };
}

async function rememberCorrection(from: string, to: string): Promise<void> {
  const { vocabulary, useHost } = await window.api.get_vocabulary();
  const replacements = vocabulary.replacements.filter(([f]) => f.toLowerCase() !== from.toLowerCase());
  replacements.push([from, to]);
  const terms = vocabulary.terms.some((term) => term.toLowerCase() === to.toLowerCase()) || to.length > 40
    ? vocabulary.terms
    : [...vocabulary.terms, to];
  await window.api.save_vocabulary({ terms, replacements }, useHost);
}

function makeCorrectable(textEl: HTMLElement, save: (text: string) => Promise<void>): void {
  textEl.classList.add('correctable');
  textEl.title = t('correct.tip', 'Double-click a word or select a phrase to correct it');
  textEl.addEventListener('mouseup', () => {
    // After the click: a double-click selects the word only once it's done.
    setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !textEl.contains(selection.anchorNode)) return;
      const picked = selection
        .toString()
        .trim()
        .replace(/^[^\p{L}\p{N}.]+|[^\p{L}\p{N}]+$/gu, '');
      if (!picked || picked.length > 80 || picked.includes('\n')) return;
      openCorrection(textEl, picked, selection.getRangeAt(0).getBoundingClientRect(), save);
    });
  });
}

function openCorrection(
  textEl: HTMLElement,
  picked: string,
  at: DOMRect,
  save: (text: string) => Promise<void>,
): void {
  document.querySelector('.correct-pop')?.remove();
  const pop = document.createElement('div');
  pop.className = 'correct-pop';
  pop.innerHTML = `
    <div class="correct-from">«${escapeHtml(picked)}» →</div>
    <input type="text" class="correct-input" spellcheck="false">
    <label class="checkbox-row">
      <input type="checkbox" class="correct-remember" checked>
      <span>${t('correct.remember', 'Remember for next recordings')}</span>
    </label>
    <div class="actions">
      <button class="action" data-act="replace">${t('correct.replace', 'Replace')}</button>
      <button class="action secondary" data-act="cancel">${t('correct.cancel', 'Cancel')}</button>
    </div>`;
  document.body.appendChild(pop);
  const input = pop.querySelector('.correct-input') as HTMLInputElement;
  input.value = picked;
  const left = Math.min(at.left, window.innerWidth - pop.offsetWidth - 16);
  const below = at.bottom + 8 + pop.offsetHeight < window.innerHeight;
  pop.style.left = `${Math.max(16, left)}px`;
  pop.style.top = `${below ? at.bottom + 8 : Math.max(16, at.top - pop.offsetHeight - 8)}px`;
  input.focus();
  input.select();

  const close = () => {
    pop.remove();
    document.removeEventListener('mousedown', onOutside, true);
  };
  const onOutside = (e: MouseEvent) => {
    if (!pop.contains(e.target as Node)) close();
  };
  document.addEventListener('mousedown', onOutside, true);

  const apply = async () => {
    const to = input.value.trim();
    const remember = (pop.querySelector('.correct-remember') as HTMLInputElement).checked;
    close();
    if (!to || to === picked) return;
    const { text, count } = replaceWholeWords(textEl.textContent || '', picked, to);
    if (!count) return;
    textEl.textContent = text;
    const parts = [t('correct.done', 'Replaced {n}', { n: String(count) })];
    try {
      await save(text);
    } catch {
      parts.push(t('correct.notSaved', 'not saved to history'));
    }
    if (remember) {
      try {
        await rememberCorrection(picked, to);
        parts.push(t('correct.remembered', 'remembered'));
      } catch {
        // the vocabulary stays as it was
      }
    }
    showCorrectionNote(textEl, parts.join(' · '));
  };
  pop.querySelector('[data-act="replace"]')?.addEventListener('click', () => void apply());
  pop.querySelector('[data-act="cancel"]')?.addEventListener('click', close);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void apply();
    if (e.key === 'Escape') close();
  });
}

function showCorrectionNote(textEl: HTMLElement, message: string): void {
  let note = textEl.parentElement?.querySelector('.correct-note') as HTMLDivElement | null;
  if (!note) {
    note = document.createElement('div');
    note.className = 'correct-note';
    textEl.after(note);
  }
  note.textContent = message;
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
  setText(id: string, text: string): Promise<void>;
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
    async setText(id, text) {
      const res = await authorizedFetch(base, `/api/history/${id}/text`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error('not saved');
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
      return new Blob([new Uint8Array(data)], { type: CLIENT_AUDIO_MIME[ext] || 'application/octet-stream' });
    },
    async setText(id, text) {
      if (!(await window.api.set_client_history_text(id, text)).ok) throw new Error('not saved');
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

  // Recordings still waiting for a transcript come first, and show up even
  // with the server off — they live on this computer, not on the host.
  let pending: PendingRecording[] = [];
  try {
    pending = (await window.api.list_recordings()).items;
  } catch {
    // listed next time
  }
  const show = (html: string) => {
    gate.innerHTML = pending.map(pendingCardHtml).join('') + html;
    gate.querySelectorAll<HTMLDivElement>('.job[data-recording]').forEach((card) => wirePendingCard(card));
  };

  let backend: HistoryBackend;
  if (state.role === 'client') {
    backend = clientHistoryBackend();
  } else {
    const base = serverBaseUrl(state);
    if (base === null) {
      show(`<div class="banner">${t('banner.off', 'Server is off. Go to the Server tab and press Start.')}</div>`);
      return;
    }
    backend = hostHistoryBackend(base);
  }

  let items: HistoryItem[];
  try {
    items = await backend.list();
  } catch {
    show(`<div class="banner">${t('job.err.unreachable', 'Could not reach the server.')}</div>`);
    return;
  }

  if (items.length === 0) {
    show(pending.length ? '' : `<div class="banner">${t('history.empty', 'No transcriptions yet.')}</div>`);
    return;
  }

  show(items.map((item) => historyCardHtml(item)).join(''));
  gate.querySelectorAll<HTMLDivElement>('.job:not([data-recording])').forEach((card) => wireHistoryCard(card, backend));
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function pendingCardHtml(rec: PendingRecording): string {
  const recording = rec.state === 'recording';
  const sending = recordingsInFlight.has(rec.id);
  const status = recording
    ? `<div class="job-status status-error">● ${t('history.pending.recording', 'Recording')}</div>`
    : `<div class="job-status status-queued">${
        sending ? t('history.pending.sending', 'Transcribing...') : t('history.pending.notYet', 'Not transcribed')
      }</div>`;
  const notes = [
    new Date(rec.createdAt).toLocaleString(),
    recording ? '' : formatDuration(rec.seconds),
    rec.interrupted ? t('history.pending.interrupted', 'recovered after the app closed mid-recording') : '',
  ].filter(Boolean);
  return `
    <div class="job" data-recording="${rec.id}" data-name="${escapeHtml(rec.name)}">
      <div class="job-head">
        <div class="job-name">${escapeHtml(rec.name)}</div>
        ${status}
      </div>
      <div class="progress-text">${escapeHtml(notes.join(' · '))}</div>
      <div class="history-audio"></div>
      ${
        recording
          ? ''
          : `<div class="actions">
        <button class="action" data-action="transcribe"${sending ? ' disabled' : ''}>${t('rec.pending.send', 'Transcribe')}</button>
        <button class="action secondary" data-action="play">${t('history.play', 'Play')}</button>
        <button class="action secondary" data-action="show">${t('job.showFile', 'Show file')}</button>
        <button class="action danger" data-action="delete"${sending ? ' disabled' : ''}>${t('history.delete', 'Delete')}</button>
      </div>`
      }
    </div>
  `;
}

function wirePendingCard(card: HTMLDivElement): void {
  const id = card.dataset.recording!;
  const name = card.dataset.name!;
  const audioSlot = card.querySelector('.history-audio') as HTMLDivElement;
  card.querySelector('[data-action="transcribe"]')?.addEventListener('click', () => void transcribeSavedRecording(id, name));
  card.querySelector('[data-action="show"]')?.addEventListener('click', () => void window.api.show_recording(id));
  const playBtn = card.querySelector('[data-action="play"]') as HTMLButtonElement | null;
  playBtn?.addEventListener('click', async () => {
    playBtn.disabled = true;
    const { data } = await window.api.read_recording(id);
    if (!data) {
      playBtn.disabled = false;
      return;
    }
    buildAudioPlayer(audioSlot, URL.createObjectURL(new Blob([data as BlobPart], { type: 'audio/wav' })));
    playBtn.remove();
  });
  const deleteBtn = card.querySelector('[data-action="delete"]') as HTMLButtonElement | null;
  deleteBtn?.addEventListener('click', async () => {
    const ok = confirm(t('history.pending.deleteConfirm', 'Delete this recording? It has not been transcribed, and this cannot be undone.'));
    if (!ok) return;
    deleteBtn.disabled = true;
    await window.api.delete_recording(id);
    card.remove();
  });
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
        <button class="action secondary" data-action="retranscribe">${t('history.retranscribe', 'Transcribe again')}</button>
        <button class="action danger" data-action="delete">${t('history.delete', 'Delete')}</button>
      </div>
      <div class="transcript-box" hidden></div>
    </div>
  `;
}

/** A call recording — 16-bit PCM stereo, me left / call right — gets
 * transcribed per side (speakers=me-others); anything else as one mix. */
function isStereoPcmWav(head: Uint8Array): boolean {
  if (head.length < 36) return false;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const tag = (at: number) => String.fromCharCode(...head.subarray(at, at + 4));
  return (
    tag(0) === 'RIFF' &&
    tag(8) === 'WAVE' &&
    tag(12) === 'fmt ' &&
    view.getUint16(20, true) === 1 &&
    view.getUint16(22, true) === 2 &&
    view.getUint16(34, true) === 16
  );
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
  const retranscribeBtn = card.querySelector('[data-action="retranscribe"]') as HTMLButtonElement;
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
        makeCorrectable(textBox.querySelector('.transcript-text') as HTMLDivElement, (fixed) => backend.setText(id, fixed));
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

  // The same audio once more — e.g. after an engine fix, or with another
  // language picked on the Record tab. The new transcript is a new entry;
  // this one stays until deleted.
  retranscribeBtn.addEventListener('click', async () => {
    retranscribeBtn.disabled = true;
    try {
      const blob = await backend.audioBlob(id, ext);
      const name = card.querySelector('.job-name')?.textContent || `audio${ext}`;
      const file = new File([blob], name, { type: blob.type });
      const stereo = isStereoPcmWav(new Uint8Array(await blob.slice(0, 64).arrayBuffer()));
      showTab('record');
      // Without a server the Record tab shows a banner saying why.
      if (recordUpload) void recordUpload(file, stereo ? { speakers: 'me-others' } : {});
    } catch {
      // audio unavailable — the button stays clickable to retry
    } finally {
      retranscribeBtn.disabled = false;
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
const appVersionText = document.getElementById('appVersionText') as HTMLSpanElement;
const checkUpdatesBtn = document.getElementById('checkUpdatesBtn') as HTMLButtonElement;
const autoUpdateCheckbox = document.getElementById('autoUpdateCheckbox') as HTMLInputElement;
const hostSecretInput = document.getElementById('hostSecretInput') as HTMLInputElement;
const copySecretBtn = document.getElementById('copySecretBtn') as HTMLButtonElement;
const regenSecretBtn = document.getElementById('regenSecretBtn') as HTMLButtonElement;
const langSwitch = document.getElementById('langSwitch') as HTMLSelectElement;
const langSwitchBusy = document.getElementById('langSwitchBusy') as HTMLParagraphElement;
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

let currentAppVersion = '';

function showAppVersionText(): void {
  appVersionText.textContent = t('about.version', 'Mova Flow v{version}', { version: currentAppVersion });
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
  autoUpdateCheckbox.checked = state.autoUpdate;
  currentAppVersion = state.appVersion;
  showAppVersionText();
  renderServerState(state);
  refreshTranscribeGate();
}

checkUpdatesBtn.addEventListener('click', async () => {
  checkUpdatesBtn.disabled = true;
  checkUpdatesBtn.textContent = t('about.checking', 'Checking...');

  const result = await window.api.check_for_updates();

  checkUpdatesBtn.disabled = false;
  checkUpdatesBtn.textContent = t('about.checkUpdates', 'Check for updates');
  renderUpdateBanner(result);

  // 'available'/'downloading'/'downloaded' already show as the persistent top
  // banner (see renderUpdateBanner) — this only has to speak up for the outcomes
  // that banner stays silent about, and only briefly before reverting to
  // the plain version string.
  if (result.stage === 'not-available') {
    appVersionText.textContent = t('about.upToDate', "You're up to date — v{version}", {
      version: currentAppVersion,
    });
    setTimeout(showAppVersionText, 4000);
  } else if (result.stage === 'error' && !result.version) {
    appVersionText.textContent = t('about.checkFailed', "Couldn't check for updates: {error}", {
      error: result.error || '',
    });
    setTimeout(showAppVersionText, 4000);
  }
});

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
  set('navLabelRecord', 'nav.record', 'Record');
  set('navLabelSettings', 'nav.settings', 'Settings');
  setTooltip('tabBtnRecord', 'nav.record', 'Record');
  setTooltip('tabBtnSettings', 'nav.settings', 'Settings');
  set('recordTitle', 'record.title', 'Record a call');
  set('settingsTitle', 'settings.title', 'Settings');
  set('settingsRecordingTitle', 'settings.recording', 'Recording');
  set('recMicLabel', 'rec.mic', 'Microphone');
  set('recMicHint', 'rec.mic.hint', 'Used for your side of the call in Record.');
  set('recMicNote', 'rec.mic.bluetooth', 'A Bluetooth microphone switches your headphones to headset mode while recording, so the call sounds worse in your ears. The built-in mic avoids that.');
  set('settingsLanguageTitle', 'settings.language', 'Language');
  set('langSwitchBusy', 'settings.language.busy', "Can't change the language while a call is being recorded.");
  set('settingsUpdatesTitle', 'settings.updates', 'Updates');
  set('settingsVocabTitle', 'settings.vocab', 'Vocabulary');
  set('vocabTermsLabel', 'vocab.terms', 'Terms');
  set('vocabTermsHint', 'vocab.terms.hint', '');
  set('vocabReplacementsLabel', 'vocab.replacements', 'Replacements');
  set('vocabReplacementsHint', 'vocab.replacements.hint', '');
  set('vocabUseHostLabel', 'vocab.useHost', "Also use the host's vocabulary");
  set('vocabHostNote', 'vocab.hostNote', '');
  set('vocabSaved', 'vocab.saved', 'Saved.');
  setTooltip('tabBtnTranscribe', 'nav.upload', 'Upload');
  setTooltip('tabBtnHistory', 'nav.history', 'History');
  setTooltip('tabBtnServer', 'nav.server', 'Server');
  set('langSwitchLabel', 'lang.switch.label', 'Interface language');
  set('historyTitle', 'history.title', 'History');
  set('serverTitle', 'server.title', 'Server');
  set('roleHostTitle', 'role.host.title', 'Server (host)');
  set('roleHostDesc', 'role.host.desc', 'This machine holds the model and runs the transcription (GPU recommended, not required).');
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
  set('checkUpdatesBtn', 'about.checkUpdates', 'Check for updates');
  set('autoUpdateLabel', 'about.autoUpdate', 'Update automatically');
  set('autoUpdateHint', 'about.autoUpdate.hint', 'Downloads new versions in the background and asks you to restart once ready. Off: you get a notice and choose when to download.');
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

/** available → (Download) → downloading with progress → downloaded →
 * (Restart). With auto-update on, main starts the download itself, so the
 * banner goes straight to progress. A failed download keeps its version and
 * offers a retry; a failed *check* (no version) stays out of the banner —
 * the About row reports that one. */
function renderUpdateBanner(state: UpdateState): void {
  const version = escapeHtml(state.version || '');
  let html = '';
  if (state.stage === 'available') {
    html = `
      <span>${t('update.available', 'Mova Flow {version} is available.', { version })}</span>
      <button class="action" data-update-action="download">${t('update.download', 'Download')}</button>
    `;
  } else if (state.stage === 'downloading') {
    const percent = Math.max(0, Math.min(100, state.percent || 0));
    html = `
      <span>${t('update.downloading', 'Downloading Mova Flow {version}... {percent}%', { version, percent: String(percent) })}</span>
      <span class="update-progress"><span style="width: ${percent}%"></span></span>
    `;
  } else if (state.stage === 'downloaded') {
    html = `
      <span>${t('update.downloaded', 'Mova Flow {version} is ready.', { version })}</span>
      <button class="action" data-update-action="install">${t('update.restart', 'Restart to update')}</button>
    `;
  } else if (state.stage === 'error' && state.version) {
    html = `
      <span>${t('update.downloadFailed', "Couldn't download Mova Flow {version}: {error}", { version, error: escapeHtml(state.error || '') })}</span>
      <button class="action" data-update-action="download">${t('update.retry', 'Try again')}</button>
    `;
  }
  updateBanner.hidden = !html;
  updateBanner.innerHTML = html;
}

updateBanner.addEventListener('click', (event) => {
  const action = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-update-action]')?.dataset.updateAction;
  if (action === 'download') void window.api.download_update();
  if (action === 'install') void window.api.install_update();
});

// ── Vocabulary (Settings) — see main/vocabulary.ts ──
const vocabTerms = document.getElementById('vocabTerms') as HTMLTextAreaElement;
const vocabReplacements = document.getElementById('vocabReplacements') as HTMLTextAreaElement;
const vocabUseHost = document.getElementById('vocabUseHost') as HTMLInputElement;
const vocabSaved = document.getElementById('vocabSaved') as HTMLParagraphElement;
let vocabSavedTimer: ReturnType<typeof setTimeout> | null = null;

/** "as heard → as it should be" (also ->, =>, =) per line. */
function parseReplacementLines(text: string): [string, string][] {
  return text
    .split('\n')
    .map((line) => line.split(/\s*(?:→|->|=>|=)\s*/))
    .filter((parts) => parts.length >= 2 && parts[0].trim())
    .map((parts) => [parts[0].trim(), parts.slice(1).join(' ').trim()] as [string, string]);
}

async function loadVocabulary(role: string): Promise<void> {
  const { vocabulary, useHost } = await window.api.get_vocabulary();
  vocabTerms.value = vocabulary.terms.join(', ');
  vocabReplacements.value = vocabulary.replacements.map(([from, to]) => `${from} → ${to}`).join('\n');
  vocabUseHost.checked = useHost;
  (document.getElementById('vocabUseHostRow') as HTMLLabelElement).hidden = role !== 'client';
  (document.getElementById('vocabHostNote') as HTMLParagraphElement).hidden = role !== 'host';
}

async function saveVocabulary(): Promise<void> {
  const terms = vocabTerms.value.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
  const { vocabulary } = await window.api.save_vocabulary(
    { terms, replacements: parseReplacementLines(vocabReplacements.value) },
    vocabUseHost.checked,
  );
  vocabTerms.value = vocabulary.terms.join(', ');
  vocabReplacements.value = vocabulary.replacements.map(([from, to]) => `${from} → ${to}`).join('\n');
  vocabSaved.hidden = false;
  if (vocabSavedTimer) clearTimeout(vocabSavedTimer);
  vocabSavedTimer = setTimeout(() => (vocabSaved.hidden = true), 1500);
}

for (const el of [vocabTerms, vocabReplacements, vocabUseHost]) el.addEventListener('change', () => void saveVocabulary());

autoUpdateCheckbox.addEventListener('change', () => {
  void window.api.set_auto_update(autoUpdateCheckbox.checked);
});

async function init(): Promise<void> {
  const state = await window.api.get_state();
  uiRole = state.role;
  setLang(state.language || 'en');
  langSwitch.value = getLang();
  applyStaticTranslations(getLang());
  document.title = 'Mova Flow';
  showTab('transcribe');
  refreshServerTab();
  // Subscribe before reading the current state: main starts checking for
  // updates while this page is still loading, and a change landing between
  // the read and the subscription would otherwise only show after a reload.
  window.api.on_update_state(renderUpdateBanner);
  renderUpdateBanner(await window.api.get_update_state());
  // Belt and braces for a window that sat hidden in the tray while the
  // update moved on — re-read whenever it comes back to the front.
  window.addEventListener('focus', () => void window.api.get_update_state().then(renderUpdateBanner));
}
void tabbar; // tabbar is always visible in Electron, unlike the Python version
             // which hid it until window.pywebview appeared
init();
