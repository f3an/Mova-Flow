// Builds native/macos/audio-tap into build/bin/mova-audio-tap — the system
// audio capture helper bundled into the macOS app (mac.extraResources). A
// no-op everywhere else: Windows captures system audio through Electron.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

if (process.platform !== 'darwin') process.exit(0);

mkdirSync('build/bin', { recursive: true });
execFileSync(
  'xcrun',
  [
    'swiftc', '-O',
    // Swift 5 language mode: the helper's globals are only touched from one
    // serial queue, which Swift 6's strict checking can't see — keep its
    // warnings warnings on whatever Xcode CI ships.
    '-swift-version', '5',
    // Core Audio process taps exist since macOS 14.2.
    '-target', 'arm64-apple-macos14.2',
    'native/macos/audio-tap/main.swift',
    '-o', 'build/bin/mova-audio-tap',
    // Embed Info.plist (NSAudioCaptureUsageDescription) in the binary itself.
    '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist',
    '-Xlinker', 'native/macos/audio-tap/Info.plist',
  ],
  { stdio: 'inherit' },
);
console.log('Built build/bin/mova-audio-tap');
