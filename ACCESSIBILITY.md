# Accessibility

Mova Flow turns speech into text, so it is often used by people who rely on transcripts — and we want the app itself to be usable by as many people as possible. This file describes what works today, what doesn't yet, and how to tell us about barriers.

## Supported environments

- **Desktop app:** macOS (Apple Silicon) and Windows, built on Electron, so it works with the platform screen readers that read Chromium content — VoiceOver on macOS, Narrator and NVDA on Windows.
- **Interface languages:** English and Ukrainian, switchable in the app.
- **Website** (<https://f3an.github.io/Mova-Flow/>): any current browser. Its animations stop when the system asks for reduced motion (`prefers-reduced-motion`), and every animated scene has a text description.

## What we do

- Controls are native HTML buttons, inputs and selects, so they are reachable with the keyboard and announced by screen readers.
- Icon-only buttons (navigation, collapsed sidebar, playback) carry `aria-label`s; the app picker dialog is marked up as a modal dialog.
- Keyboard focus is visible on navigation items.
- Transcripts are plain text you can select, copy, download as `.txt`, and edit in place.
- Recordings and transcripts are kept on your own machines, so assistive tools can open the files directly.

## Known limitations

- We have not yet run a full audit with a screen reader, and some parts — the recording timer, transcription progress, the in-place correction popover — may not announce their changes.
- Not every custom-styled element has been checked for colour contrast against WCAG 2.2 AA.
- There are no global keyboard shortcuts for starting or stopping a recording yet.
- The Meet Recorder browser extension lives in its own repository and is not covered here.

## Reporting a barrier

If something in Mova Flow is hard or impossible to use with your setup, please [open an issue](https://github.com/f3an/Mova-Flow/issues/new/choose) and include:

- your operating system and Mova Flow version;
- the assistive technology you use (screen reader, magnifier, voice control, keyboard only, …);
- what you tried to do and what happened instead.

Accessibility issues are treated as bugs, not feature requests.
