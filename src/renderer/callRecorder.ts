// "Record a call": the microphone on the left channel, everything the computer
// plays (the other side of a Zoom/Teams/Telegram… call) on the right — the
// same layout the Meet extension uploads, so the host labels each line
// "Me" / "Others" (speakers=me-others, whisper-cli --diarize).
//
// Both sides are captured straight to 16 kHz 16-bit PCM as they come in,
// rather than as compressed recordings decoded at the end: an hour is then
// ~115 MB per side instead of a multi-GB decode.
//
// System audio comes from Electron on Windows (getDisplayMedia, answered in
// main/systemAudio.ts with a loopback device) and from the bundled Core Audio
// helper on macOS, which hands back a finished WAV when recording stops.

const SAMPLE_RATE = 16000;

export type Side = 'me' | 'call';

interface CallRecorderApi {
  ensure_microphone_access(): Promise<boolean>;
  system_audio_start(appBundleId?: string): Promise<{ startedAt: number }>;
  system_audio_stop(): Promise<Uint8Array | null>;
}

/** PCM collected for one side, timestamped so the two sides can be lined up. */
interface Track {
  chunks: Int16Array[];
  frames: number;
  /** Epoch ms of the first sample; 0 until audio arrives. */
  startedAt: number;
}

function newTrack(): Track {
  return { chunks: [], frames: 0, startedAt: 0 };
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
    track.chunks.push(toInt16(samples));
    track.frames += samples.length;
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

/** Reads the PCM out of the macOS helper's 16 kHz mono 16-bit WAV. */
function wavToTrack(bytes: Uint8Array, startedAt: number): Track {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (id === 'data') {
      const end = Math.min(offset + 8 + size, bytes.byteLength);
      // Copy: the data chunk isn't guaranteed to be 2-byte aligned in `bytes`.
      const pcm = new Int16Array(bytes.slice(offset + 8, end).buffer);
      return { chunks: [pcm], frames: pcm.length, startedAt };
    }
    offset += 8 + size + (size % 2);
  }
  return { ...newTrack(), startedAt };
}

/** Lines both sides up by their start times and interleaves them into a
 * stereo 16-bit WAV: left = me, right = call. */
function toStereoWav(me: Track, call: Track): Blob {
  const started = [me, call].filter((t) => t.frames > 0).map((t) => t.startedAt);
  const t0 = started.length ? Math.min(...started) : 0;
  const offsetOf = (t: Track) => (t.frames ? Math.round(((t.startedAt - t0) / 1000) * SAMPLE_RATE) : 0);
  const frames = Math.max(offsetOf(me) + me.frames, offsetOf(call) + call.frames);

  const dataSize = frames * 4;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const writeString = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true); // stereo
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const samples = new Int16Array(out, 44);
  const place = (track: Track, channel: number) => {
    let frame = offsetOf(track);
    for (const chunk of track.chunks) {
      for (let i = 0; i < chunk.length && frame < frames; i++, frame++) samples[frame * 2 + channel] = chunk[i];
    }
  };
  place(me, 0);
  place(call, 1);
  return new Blob([out], { type: 'audio/wav' });
}

export class CallRecorder {
  private ctx: AudioContext | null = null;
  private streams: MediaStream[] = [];
  private disconnects: (() => void)[] = [];
  private me = newTrack();
  private call = newTrack();
  private macCallStartedAt = 0;

  constructor(
    private readonly api: CallRecorderApi,
    private readonly platform: string,
    private readonly onLevel: (side: Side, level: number) => void,
  ) {}

  /** `appBundleId` (macOS): record only that app's audio instead of
   * everything the computer plays. `micDeviceId`: which microphone records
   * the user (the system default when omitted, or if that one is gone).
   * Throws with a user-facing message if either side can't be captured;
   * nothing is left running in that case. */
  async start(appBundleId?: string, micDeviceId?: string): Promise<void> {
    this.me = newTrack();
    this.call = newTrack();
    try {
      if (!(await this.api.ensure_microphone_access())) {
        throw new Error('Microphone access was denied. Allow it for Mova Flow in System Settings → Privacy & Security → Microphone.');
      }
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
      this.disconnects.push(capture(this.ctx, mic, this.me, (level) => this.onLevel('me', level)));

      if (this.platform === 'darwin') {
        // Levels arrive from main as 'system-audio-level' (see renderer.ts).
        const { startedAt } = await this.api.system_audio_start(appBundleId);
        this.macCallStartedAt = startedAt;
      } else {
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        this.streams.push(display);
        for (const track of display.getVideoTracks()) track.stop();
        if (!display.getAudioTracks().length) throw new Error("This computer's audio can't be captured.");
        this.disconnects.push(capture(this.ctx, display, this.call, (level) => this.onLevel('call', level)));
      }
    } catch (err) {
      await this.teardown();
      throw err;
    }
  }

  /** Stops both sides and returns the stereo WAV ready to upload. */
  async stop(): Promise<Blob> {
    let macCall: Uint8Array | null = null;
    if (this.platform === 'darwin') macCall = await this.api.system_audio_stop().catch(() => null);
    await this.teardown();
    const call = macCall ? wavToTrack(macCall, this.macCallStartedAt) : this.call;
    return toStereoWav(this.me, call);
  }

  private async teardown(): Promise<void> {
    for (const disconnect of this.disconnects) disconnect();
    this.disconnects = [];
    for (const stream of this.streams) for (const track of stream.getTracks()) track.stop();
    this.streams = [];
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
