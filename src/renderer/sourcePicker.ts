// "Where should the call audio come from?" — a modal of cards, like a
// screen-share picker: everything the computer plays, or one app (macOS),
// each shown with a thumbnail of its window (or its icon when the Screen
// Recording permission isn't there — see listCaptureSources in main).

export interface CaptureSource {
  bundleId: string;
  name: string;
  playing: boolean;
  icon?: string;
  thumbnail?: string;
}

type Translate = (key: string, fallback: string, vars?: Record<string, string>) => string;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Resolves with the chosen app's bundle ID, '' for all system audio, or
 * null if the picker was dismissed. */
export function pickCaptureSource(load: () => Promise<CaptureSource[]>, t: Translate): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'picker-overlay';
    overlay.innerHTML = `
      <div class="picker" role="dialog" aria-modal="true" aria-labelledby="pickerTitle">
        <div class="picker-head">
          <h3 id="pickerTitle">${t('picker.title', 'Where should the call audio come from?')}</h3>
          <button class="picker-refresh" id="pickerRefresh" title="${t('picker.refresh', 'Refresh')}">⟲</button>
        </div>
        <p class="picker-sub">${t(
          'picker.sub',
          'Pick the app your call is in to leave notifications, music and other apps out of the recording.',
        )}</p>
        <div class="picker-grid" id="pickerGrid"></div>
        <p class="picker-note" id="pickerNote" hidden></p>
        <div class="picker-actions">
          <button class="action secondary" id="pickerCancel">${t('picker.cancel', 'Cancel')}</button>
          <button class="action" id="pickerOk">● ${t('picker.record', 'Record')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const grid = overlay.querySelector('#pickerGrid') as HTMLDivElement;
    const note = overlay.querySelector('#pickerNote') as HTMLParagraphElement;
    let selected = '';
    // Until the user clicks a card, the selection follows the playing app.
    let userPicked = false;

    const finish = (value: string | null) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(null);
      if (e.key === 'Enter') finish(selected);
    };
    document.addEventListener('keydown', onKey);

    const card = (value: string, preview: string, footer: string, playing: boolean) => `
      <button class="picker-card${value === selected ? ' selected' : ''}" data-value="${escapeHtml(value)}">
        <div class="picker-preview">${preview}</div>
        <div class="picker-label">${footer}${
          playing ? `<span class="picker-playing">● ${t('picker.playing', 'playing')}</span>` : ''
        }</div>
      </button>`;

    const render = (sources: CaptureSource[]) => {
      // Default to the app that's playing right now — most likely the call.
      // (The grid is first drawn empty while the list loads, so this can't
      // key off "first render".)
      if (!userPicked) selected = sources.find((s) => s.playing)?.bundleId ?? selected;
      const allCard = card(
        '',
        `<div class="picker-all">🔊</div>`,
        `<span class="picker-name">${t('rec.source.all', 'All system audio')}</span>`,
        false,
      );
      grid.innerHTML =
        allCard +
        sources
          .map((s) =>
            card(
              s.bundleId,
              s.thumbnail
                ? `<img class="picker-thumb" src="${s.thumbnail}" alt="">`
                : s.icon
                  ? `<img class="picker-bigicon" src="${s.icon}" alt="">`
                  : `<div class="picker-all">▢</div>`,
              `${s.icon ? `<img class="picker-icon" src="${s.icon}" alt="">` : ''}<span class="picker-name">${escapeHtml(s.name)}</span>`,
              s.playing,
            ),
          )
          .join('');
      const anyThumb = sources.some((s) => s.thumbnail);
      note.hidden = anyThumb || !sources.length;
      note.textContent = t(
        'picker.noThumbs',
        'To see window previews, allow Mova Flow in System Settings → Privacy & Security → Screen & System Audio Recording. Recording works the same without them.',
      );
      if (![...grid.querySelectorAll<HTMLButtonElement>('.picker-card')].some((c) => c.dataset.value === selected)) {
        selected = '';
        grid.querySelector('.picker-card')?.classList.add('selected');
      }
    };

    const refresh = async () => {
      grid.classList.add('loading');
      try {
        render(await load());
      } catch {
        render([]);
      } finally {
        grid.classList.remove('loading');
      }
    };

    grid.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLButtonElement>('.picker-card');
      if (!target) return;
      selected = target.dataset.value ?? '';
      userPicked = true;
      grid.querySelectorAll('.picker-card').forEach((c) => c.classList.toggle('selected', c === target));
    });
    grid.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.picker-card')) finish(selected);
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });
    overlay.querySelector('#pickerCancel')?.addEventListener('click', () => finish(null));
    overlay.querySelector('#pickerOk')?.addEventListener('click', () => finish(selected));
    overlay.querySelector('#pickerRefresh')?.addEventListener('click', () => void refresh());

    render([]);
    void refresh();
  });
}
