// "Record a call": the microphone on the left channel, everything the computer
// plays (the other side of a Zoom/Teams/Telegram… call) on the right — the
// same layout the Meet extension uploads, so the host labels each line
// "Me" / "Others" (speakers=me-others, whisper-cli --diarize).
//
// Both sides are captured straight to 16 kHz 16-bit PCM as they come in and
// handed to main every second, which appends them to the recording's folder
// on disk (see main/recordings.ts) — nothing waits in memory for Stop, so a
// crash or a dead battery mid-call loses a second, not the call. Main turns
// the parts into the stereo WAV on Stop.
//
// System audio comes from Electron on Windows (getDisplayMedia, answered in
// main/systemAudio.ts with a loopback device) and from the bundled Core Audio
// helper on macOS, which main starts writing straight into the same folder.

const SAMPLE_RATE = 16000;
const FLUSH_MS = 1000;

export type Side = 'me' | 'call';

export interface FinishedRecording {
  id: string;
  name: string;
}

interface CallRecorderApi {
  ensure_microphone_access(): Promise<boolean>;
  recording_begin(name: string): Promise<{ id: string }>;
  recording_append(id: string, side: Side, startedAt: number, pcm: ArrayBuffer): Promise<void>;
  recording_finish(id: string): Promise<FinishedRecording | null>;
  delete_recording(id: string): Promise<{ ok: boolean }>;
  system_audio_start(recordingId: string, appBundleId?: string): Promise<{ startedAt: number }>;
}

/** PCM captured for one side since the last flush. */
interface Track {
  side: Side;
  pending: Int16Array[];
  /** Epoch ms of the first sample; 0 until audio arrives. */
  startedAt: number;
}

function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

/** Pipes a stream into `track` as 16 kHz mono PCM; returns a disconnect fn. */
function capture(ctx: AudioContext, stream: MediaStream, track: Track, onLevel: (level: number) => void): () => void {
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but needs no separate worklet module — and
  // this only ever runs two of them at 16 kHz.
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  processor.onaudioprocess = (event) => {
    const samples = event.inputBuffer.getChannelData(0);
    if (!track.startedAt) track.startedAt = Date.now() - (samples.length / SAMPLE_RATE) * 1000;
    track.pending.push(toInt16(samples));
    onLevel(rms(samples));
  };
  source.connect(processor);
  // A ScriptProcessor only runs while connected to the destination; the zero
  // gain keeps the user from hearing their own mic.
  processor.connect(mute);
  mute.connect(ctx.destination);
  return () => {
    processor.onaudioprocess = null;
    source.disconnect();
    processor.disconnect();
    mute.disconnect();
  };
}

export class CallRecorder {
  private ctx: AudioContext | null = null;
  private streams: MediaStream[] = [];
  private disconnects: (() => void)[] = [];
  private tracks: Track[] = [];
  private id: string | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** Appends go to main strictly one after another. */
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly api: CallRecorderApi,
    private readonly platform: string,
    private readonly onLevel: (side: Side, level: number) => void,
  ) {}

  /** Starts recording `name` (e.g. "Call 2026-10-05 14-01.wav").
   * `appBundleId` (macOS): record only that app's audio instead of
   * everything the computer plays. `micDeviceId`: which microphone records
   * the user (the system default when omitted, or if that one is gone).
   * Throws with a user-facing message if either side can't be captured;
   * nothing is left running (or on disk) in that case. */
  async start(name: string, appBundleId?: string, micDeviceId?: string): Promise<void> {
    const me: Track = { side: 'me', pending: [], startedAt: 0 };
    this.tracks = [me];
    try {
      if (!(await this.api.ensure_microphone_access())) {
        throw new Error('Microphone access was denied. Allow it for Mova Flow in System Settings → Privacy & Security → Microphone.');
      }
      this.id = (await this.api.recording_begin(name)).id;
      const processing = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      const mic = await navigator.mediaDevices
        .getUserMedia({ audio: micDeviceId ? { ...processing, deviceId: { exact: micDeviceId } } : processing })
        // The chosen mic was unplugged since — record with the default rather than not at all.
        .catch((err: Error) => {
          if (micDeviceId && err.name === 'OverconstrainedError') return navigator.mediaDevices.getUserMedia({ audio: processing });
          throw err;
        });
      this.streams.push(mic);
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      await this.ctx.resume();
      this.disconnects.push(capture(this.ctx, mic, me, (level) => this.onLevel('me', level)));

      if (this.platform === 'darwin') {
        // Main writes the call side itself; levels arrive as 'system-audio-level' (see renderer.ts).
        await this.api.system_audio_start(this.id, appBundleId);
      } else {
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        this.streams.push(display);
        for (const track of display.getVideoTracks()) track.stop();
        if (!display.getAudioTracks().length) throw new Error("This computer's audio can't be captured.");
        const call: Track = { side: 'call', pending: [], startedAt: 0 };
        this.tracks.push(call);
        this.disconnects.push(capture(this.ctx, display, call, (level) => this.onLevel('call', level)));
      }
      this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    } catch (err) {
      await this.teardown();
      if (this.id) await this.api.delete_recording(this.id).catch(() => {});
      this.id = null;
      throw err;
    }
  }

  /** Stops both sides; main assembles the stereo WAV. Returns which saved
   * recording that is (null if it couldn't be finished — its parts are then
   * still on disk and History picks them up). */
  async stop(): Promise<FinishedRecording | null> {
    await this.teardown();
    this.flush();
    await this.writes;
    const id = this.id;
    this.id = null;
    if (!id) return null;
    return this.api.recording_finish(id).catch(() => null);
  }

  private flush(): void {
    const id = this.id;
    if (!id) return;
    for (const track of this.tracks) {
      if (!track.pending.length) continue;
      const chunks = track.pending;
      track.pending = [];
      const pcm = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const chunk of chunks) {
        pcm.set(chunk, at);
        at += chunk.length;
      }
      const { side, startedAt } = track;
      this.writes = this.writes.then(() =>
        this.api.recording_append(id, side, startedAt, pcm.buffer).catch((err) => console.error('recording_append', err)),
      );
    }
  }

  private async teardown(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    for (const disconnect of this.disconnects) disconnect();
    this.disconnects = [];
    for (const stream of this.streams) for (const track of stream.getTracks()) track.stop();
    this.streams = [];
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
