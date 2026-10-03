// Who-said-what from the meeting itself: the meet recorder logs Google Meet's
// live captions while recording — each caption block carries the speaker's
// display name — as a list of turns timed from the start of the recording.
// whisper's channel diarization already separates the user from everyone
// else reliably; this only fills in *which* someone else it was.

export interface SpeakerTurn {
  name: string;
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  /** Words in the caption; 0 if the client didn't send it. */
  words: number;
  /** The user's own captions (Meet labels these "You") — never used to name
   * another speaker, since that side is already known from the mic channel. */
  self?: boolean;
}

// Captions render a beat after the words are spoken, so a turn's logged
// window sits later than the speech it describes. Shift it back by roughly
// that much, and pad the end since the last caption update can also be the
// one that arrives late.
const CAPTION_LAG_S = 0.8;
const END_PAD_S = 0.5;
// Meet sometimes delivers a whole phrase in one caption update, so the
// logged window collapses to a single instant at its end. A typical speaking
// pace (~2.5 words/s) recovers roughly when that phrase must have started.
const SECONDS_PER_WORD = 0.4;
const MAX_TURNS = 20000;
const MAX_NAME_LEN = 100;

/** Validates the untrusted JSON a client sent; anything malformed is dropped
 * rather than failing the whole transcription over a cosmetic extra. */
export function parseSpeakerTimeline(raw: unknown): SpeakerTurn[] {
  if (typeof raw !== 'string' || !raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const turns: SpeakerTurn[] = [];
  for (const item of data.slice(0, MAX_TURNS)) {
    if (!item || typeof item !== 'object') continue;
    const { name, start, end, words, self } = item as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim()) continue;
    if (typeof start !== 'number' || typeof end !== 'number' || !isFinite(start) || !isFinite(end) || end < start) continue;
    const wordCount = typeof words === 'number' && isFinite(words) && words > 0 ? Math.min(words, 10000) : 0;
    turns.push({ name: name.trim().slice(0, MAX_NAME_LEN), start, end, words: wordCount, self: self === true });
  }
  return turns;
}

/** The other participant whose captions overlap [start, end] the most, or
 * null when no one's captions cover that stretch at all. */
export function speakerAt(turns: SpeakerTurn[], start: number, end: number): string | null {
  const overlapByName = new Map<string, number>();
  for (const turn of turns) {
    if (turn.self) continue;
    const spokenFrom = Math.min(turn.start, turn.end - turn.words * SECONDS_PER_WORD);
    const from = Math.max(start, spokenFrom - CAPTION_LAG_S);
    const to = Math.min(end, turn.end - CAPTION_LAG_S + END_PAD_S);
    if (to <= from) continue;
    overlapByName.set(turn.name, (overlapByName.get(turn.name) || 0) + (to - from));
  }
  let best: string | null = null;
  let bestOverlap = 0;
  for (const [name, overlap] of overlapByName) {
    if (overlap > bestOverlap) {
      best = name;
      bestOverlap = overlap;
    }
  }
  return best;
}
