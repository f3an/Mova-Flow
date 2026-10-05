// The user's vocabulary: terms Whisper should expect (names, jargon — "ESM",
// "async/await", "EPAM") and replacements applied to the finished text for
// what it still mishears ("Async/Evade" → "async/await").
//
// Every client sends its own with each upload (`vocabulary`); the host adds
// its own unless the client opts out (`host_vocabulary=0`). Terms go to
// whisper-cli as a prompt carried into every window (--prompt
// --carry-initial-prompt): on an interview it turned "Async/Evade" into
// "async/await", though not every mishearing. Replacements catch the rest,
// and always work.

export interface Vocabulary {
  terms: string[];
  /** [as heard, as it should be] */
  replacements: [string, string][];
}

export const EMPTY_VOCABULARY: Vocabulary = { terms: [], replacements: [] };

const MAX_TERMS = 150;
const MAX_TERM = 60;
const MAX_REPLACEMENTS = 300;
const MAX_REPLACEMENT = 100;
/** whisper-cli takes at most n_text_ctx/2 (224) prompt tokens; ~600 chars
 * of short terms stays well inside that, Cyrillic included. */
const MAX_PROMPT = 600;

const clean = (s: unknown, max: number) =>
  typeof s === 'string' ? s.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '';

/** Anything — a JSON string from a request, or a config value — as a valid
 * vocabulary; whatever doesn't fit is dropped. */
export function parseVocabulary(raw: unknown): Vocabulary {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return EMPTY_VOCABULARY;
    }
  }
  if (!value || typeof value !== 'object') return EMPTY_VOCABULARY;
  const v = value as { terms?: unknown; replacements?: unknown };
  const terms = Array.isArray(v.terms) ? v.terms.map((t) => clean(t, MAX_TERM)).filter(Boolean) : [];
  const replacements = Array.isArray(v.replacements)
    ? v.replacements
        .filter((r): r is unknown[] => Array.isArray(r) && r.length === 2)
        .map((r) => [clean(r[0], MAX_REPLACEMENT), clean(r[1], MAX_REPLACEMENT)] as [string, string])
        .filter(([from]) => from)
    : [];
  return {
    terms: [...new Set(terms)].slice(0, MAX_TERMS),
    replacements: replacements.slice(0, MAX_REPLACEMENTS),
  };
}

/** Later vocabularies win on the same replacement (the client's over the host's). */
export function mergeVocabularies(...all: Vocabulary[]): Vocabulary {
  const terms = new Set<string>();
  const replacements = new Map<string, [string, string]>();
  for (const v of all) {
    for (const t of v.terms) terms.add(t);
    for (const r of v.replacements) replacements.set(r[0].toLowerCase(), r);
  }
  return { terms: [...terms].slice(0, MAX_TERMS), replacements: [...replacements.values()].slice(0, MAX_REPLACEMENTS) };
}

/** The terms as one whisper-cli prompt, or null when there are none. */
export function vocabularyPrompt(v: Vocabulary): string | null {
  let prompt = '';
  for (const term of v.terms) {
    const next = prompt ? `${prompt}, ${term}` : term;
    if (next.length > MAX_PROMPT) break;
    prompt = next;
  }
  return prompt ? `${prompt}.` : null;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole words or phrases only, ignoring case: "МДЖС" → ".mjs" leaves
 * "МДЖСКА" alone. Longer ones first, so a phrase beats a word inside it. */
export function applyReplacements(text: string, v: Vocabulary): string {
  const sorted = [...v.replacements].sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [from, to] of sorted) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(from)}(?![\\p{L}\\p{N}])`, 'giu'), () => to);
  }
  return out;
}
