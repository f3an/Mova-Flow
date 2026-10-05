// mova-audio-tap — records what this Mac is playing (system audio output)
// through a Core Audio process tap (macOS 14.2+), for Mova Flow's "record a
// call" feature. Electron can't do this itself on macOS (its 'loopback'
// display-media audio is Windows-only), and a tap needs only the narrower
// "System Audio Recording" permission — no screen recording.
//
// Usage:
//   mova-audio-tap list
//     Prints a JSON array of apps that have audio streams right now:
//     [{"bundleId":"us.zoom.xos","name":"zoom.us","playing":true,
//       "icon":"<base64 PNG>","windowIds":[1234, …]}, …]
//     windowIds are the app's windows (CGWindowIDs), largest first, for
//     `thumbs`. Window owners are readable without the Screen Recording
//     permission; only the thumbnails themselves need it.
//   mova-audio-tap thumbs <windowId>...
//     Prints {"<windowId>":"<base64 JPEG>", …}: a small snapshot of each
//     window via ScreenCaptureKit, which (unlike Electron's desktopCapturer)
//     also sees windows on other Spaces. Needs Screen Recording access;
//     windows it can't capture are simply left out.
//   mova-audio-tap <out.wav> [--app <bundleId>]
//     Records everything the system plays — or only that app (and its helper
//     processes) — as 16 kHz mono 16-bit WAV (what whisper-cli reads; ~115
//     MB/hour). Stops when stdin closes (the app ends the recording) or on
//     SIGTERM/SIGINT.
// stdout, one JSON object per line:
//   {"event":"started","at":<epoch ms the recording started>}
//   {"level":<0..1 RMS>}            ~10 times a second, for the UI meter
//   {"event":"stopped","seconds":<recorded>}
//   {"event":"error","message":"..."}   then exit 1
import AppKit
import AVFoundation
import CoreAudio
import Foundation
import ScreenCaptureKit

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ object: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) {
    print(line)
  }
}

func fail(_ message: String) -> Never {
  emit(["event": "error", "message": message])
  exit(1)
}

func check(_ status: OSStatus, _ what: String) {
  if status != noErr { fail("\(what) failed (OSStatus \(status))") }
}

func defaultOutputDeviceUID() -> String {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultOutputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var device = AudioObjectID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device), "Reading the default output device")
  address.mSelector = kAudioDevicePropertyDeviceUID
  var uid: CFString = "" as CFString
  size = UInt32(MemoryLayout<CFString>.size)
  check(withUnsafeMutablePointer(to: &uid) { AudioObjectGetPropertyData(device, &address, 0, nil, &size, $0) }, "Reading the output device UID")
  return uid as String
}

// ── Audio processes ─────────────────────────────────────────────────────
// Core Audio has one "process object" per process that uses audio. Apps
// often play through helper processes (Chrome's audio service, Electron
// helpers…), so each is attributed to the regular app whose bundle ID is a
// prefix of its own — that's what the user picks from.

/** Plain value properties only (pid_t, UInt32…) — strings go through readString. */
func readProperty<T: BitwiseCopyable>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value : nil
}

func readString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value: CFString = "" as CFString
  var size = UInt32(MemoryLayout<CFString>.size)
  let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0) }
  return status == noErr ? value as String : nil
}

func audioProcessObjects() -> [AudioObjectID] {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
  var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &objects) == noErr else { return [] }
  return objects
}

struct AudioProcess {
  let object: AudioObjectID
  let pid: pid_t
  let bundleId: String
  let playing: Bool
}

func audioProcesses() -> [AudioProcess] {
  audioProcessObjects().compactMap { object in
    guard let pid = readProperty(object, kAudioProcessPropertyPID, pid_t(0)) else { return nil }
    let bundle = readString(object, kAudioProcessPropertyBundleID) ?? ""
    let playing = (readProperty(object, kAudioProcessPropertyIsRunningOutput, UInt32(0)) ?? 0) != 0
    return AudioProcess(object: object, pid: pid, bundleId: bundle, playing: playing)
  }
}

/** The regular (Dock) app a process belongs to — itself, or the app whose
 * bundle ID prefixes its own (com.google.Chrome.helper → com.google.Chrome). */
func owningApp(_ process: AudioProcess, among apps: [NSRunningApplication]) -> NSRunningApplication? {
  if let app = NSRunningApplication(processIdentifier: process.pid), app.activationPolicy == .regular { return app }
  guard !process.bundleId.isEmpty else { return nil }
  return apps
    .filter { app in
      guard let id = app.bundleIdentifier else { return false }
      return process.bundleId == id || process.bundleId.hasPrefix(id + ".")
    }
    .max { ($0.bundleIdentifier?.count ?? 0) < ($1.bundleIdentifier?.count ?? 0) }
}

/** 64 px PNG of the app's icon, base64. */
func iconPNG(_ app: NSRunningApplication) -> String? {
  guard let icon = app.icon else { return nil }
  let size = NSSize(width: 64, height: 64)
  guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 64, bitsPerSample: 8, samplesPerPixel: 4,
    hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
  else { return nil }
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  icon.draw(in: NSRect(origin: .zero, size: size))
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])?.base64EncodedString()
}

/** Normal-layer windows of `pid` (any Space, minimized too), largest first. */
func windowIds(of pid: pid_t) -> [Int] {
  guard let info = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
  return info
    .filter { ($0[kCGWindowOwnerPID as String] as? pid_t) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
    .compactMap { window -> (id: Int, area: Double)? in
      guard let id = window[kCGWindowNumber as String] as? Int,
        let bounds = window[kCGWindowBounds as String] as? [String: Double]
      else { return nil }
      let area = (bounds["Width"] ?? 0) * (bounds["Height"] ?? 0)
      return area > 10_000 ? (id, area) : nil
    }
    .sorted { $0.area > $1.area }
    .map(\.id)
}

func listApps() -> Never {
  let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
  var byApp: [String: (app: NSRunningApplication, playing: Bool)] = [:]
  let ownPid = ProcessInfo.processInfo.processIdentifier
  for process in audioProcesses() where process.pid != ownPid {
    guard let app = owningApp(process, among: apps), let id = app.bundleIdentifier else { continue }
    byApp[id] = (app, (byApp[id]?.playing ?? false) || process.playing)
  }
  let list = byApp
    .map { id, entry -> [String: Any] in
      var item: [String: Any] = [
        "bundleId": id,
        "name": entry.app.localizedName ?? id,
        "playing": entry.playing,
        "pid": entry.app.processIdentifier,
        "windowIds": windowIds(of: entry.app.processIdentifier),
      ]
      if let icon = iconPNG(entry.app) { item["icon"] = icon }
      return item
    }
    .sorted { a, b in
      let (pa, pb) = (a["playing"] as! Bool, b["playing"] as! Bool)
      return pa != pb ? pa : (a["name"] as! String).localizedCaseInsensitiveCompare(b["name"] as! String) == .orderedAscending
    }
  if let data = try? JSONSerialization.data(withJSONObject: list), let text = String(data: data, encoding: .utf8) { print(text) }
  exit(0)
}

func printThumbnails(_ ids: [CGWindowID]) -> Never {
  // ScreenCaptureKit needs a window-server connection, which a plain
  // command-line process only gets once AppKit is initialized.
  _ = NSApplication.shared
  Task {
    var result: [String: String] = [:]
    if let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) {
      for window in content.windows where ids.contains(window.windowID) {
        let config = SCStreamConfiguration()
        let scale = min(480 / max(window.frame.width, 1), 300 / max(window.frame.height, 1), 1)
        config.width = max(Int(window.frame.width * scale), 1)
        config.height = max(Int(window.frame.height * scale), 1)
        config.showsCursor = false
        let filter = SCContentFilter(desktopIndependentWindow: window)
        guard let image = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config),
          let jpeg = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.7])
        else { continue }
        result[String(window.windowID)] = jpeg.base64EncodedString()
      }
    }
    if let data = try? JSONSerialization.data(withJSONObject: result), let text = String(data: data, encoding: .utf8) { print(text) }
    exit(0)
  }
  dispatchMain()
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.first == "list" { listApps() }
if arguments.first == "thumbs" { printThumbnails(arguments.dropFirst().compactMap { CGWindowID($0) }) }
guard let outPath = arguments.first else { fail("usage: mova-audio-tap list | mova-audio-tap <out.wav> [--app <bundleId>]") }
let outURL = URL(fileURLWithPath: outPath)
var onlyApp: String?
if let flag = arguments.firstIndex(of: "--app"), flag + 1 < arguments.count { onlyApp = arguments[flag + 1] }

// A private, unmuted tap on everything the system plays — or only on the
// chosen app's processes.
let tapDescription: CATapDescription
if let appId = onlyApp {
  let objects = audioProcesses()
    .filter { $0.bundleId == appId || $0.bundleId.hasPrefix(appId + ".") }
    .map(\.object)
  if objects.isEmpty { fail("That app isn't using audio yet — start the call first, then record.") }
  tapDescription = CATapDescription(stereoMixdownOfProcesses: objects)
} else {
  tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
}
tapDescription.uuid = UUID()
tapDescription.muteBehavior = .unmuted
tapDescription.isPrivate = true
var tapID = AudioObjectID(kAudioObjectUnknown)
check(AudioHardwareCreateProcessTap(tapDescription, &tapID), "Creating the audio tap (is System Audio Recording allowed for Mova Flow?)")

var formatAddress = AudioObjectPropertyAddress(
  mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
var streamDescription = AudioStreamBasicDescription()
var descriptionSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
check(AudioObjectGetPropertyData(tapID, &formatAddress, 0, nil, &descriptionSize, &streamDescription), "Reading the tap format")
guard let tapFormat = AVAudioFormat(streamDescription: &streamDescription) else { fail("Unsupported tap format") }

// A tap is read through a private aggregate device built around it.
let outputUID = defaultOutputDeviceUID()
let aggregateDescription: [String: Any] = [
  kAudioAggregateDeviceNameKey: "Mova Flow Tap",
  kAudioAggregateDeviceUIDKey: UUID().uuidString,
  kAudioAggregateDeviceMainSubDeviceKey: outputUID,
  kAudioAggregateDeviceIsPrivateKey: true,
  kAudioAggregateDeviceIsStackedKey: false,
  kAudioAggregateDeviceTapAutoStartKey: true,
  kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
  kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: tapDescription.uuid.uuidString]],
]
var aggregateID = AudioObjectID(kAudioObjectUnknown)
check(AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateID), "Creating the aggregate device")

guard let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
  let converter = AVAudioConverter(from: tapFormat, to: outFormat)
else { fail("Can't convert \(tapFormat) to 16 kHz mono") }
var file: AVAudioFile?
do {
  file = try AVAudioFile(forWriting: outURL, settings: outFormat.settings, commonFormat: .pcmFormatInt16, interleaved: true)
} catch {
  fail("Can't create \(outURL.path): \(error.localizedDescription)")
}

// The IO proc runs on a real-time thread: it only copies the buffer and hands
// it to this serial queue, which converts, writes and meters.
let work = DispatchQueue(label: "mova-audio-tap.work")
var framesWritten: AVAudioFramePosition = 0

// A tap only delivers audio while something is actually playing — silences
// are simply skipped. Every buffer is placed by its host timestamp and gaps
// are written out as silence, so the file always spans the whole recording
// and stays in step with the microphone recorded alongside it.
var timebase = mach_timebase_info_data_t()
mach_timebase_info(&timebase)
var startHostTime: UInt64 = 0

@Sendable func seconds(sinceStart hostTime: UInt64) -> Double {
  guard hostTime > startHostTime else { return 0 }
  return Double(hostTime - startHostTime) * Double(timebase.numer) / Double(timebase.denom) / 1e9
}

/** Writes silence up to `seconds` into the recording, if the file is behind. */
@Sendable func padSilence(upTo seconds: Double) {
  let target = AVAudioFramePosition(seconds * outFormat.sampleRate)
  var missing = target - framesWritten
  // Ignore jitter; only fill real gaps (> 50 ms).
  guard missing > AVAudioFramePosition(outFormat.sampleRate * 0.05) else { return }
  while missing > 0 {
    let chunk = AVAudioFrameCount(min(missing, 16000))
    guard let silence = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: chunk) else { return }
    silence.frameLength = chunk  // freshly allocated buffers are zeroed
    try? file?.write(from: silence)
    framesWritten += AVAudioFramePosition(chunk)
    missing -= AVAudioFramePosition(chunk)
  }
}
var levelSum: Float = 0
var levelCount = 0
var lastLevelEmit = Date()

func process(_ input: AVAudioPCMBuffer, hostTime: UInt64) {
  padSilence(upTo: seconds(sinceStart: hostTime))
  if let channels = input.floatChannelData {
    // Interleaved: every channel's samples sit in channels[0]. Planar: meter
    // the first channel only — close enough for a level meter.
    let count = Int(input.frameLength) * (tapFormat.isInterleaved ? Int(tapFormat.channelCount) : 1)
    for i in 0..<count { levelSum += channels[0][i] * channels[0][i] }
    levelCount += count
  }
  if Date().timeIntervalSince(lastLevelEmit) >= 0.1, levelCount > 0 {
    emit(["level": (levelSum / Float(levelCount)).squareRoot()])
    levelSum = 0
    levelCount = 0
    lastLevelEmit = Date()
  }

  let capacity = AVAudioFrameCount(Double(input.frameLength) * outFormat.sampleRate / tapFormat.sampleRate) + 32
  guard let output = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
  var fed = false
  var conversionError: NSError?
  converter.convert(to: output, error: &conversionError) { _, status in
    if fed {
      status.pointee = .noDataNow
      return nil
    }
    fed = true
    status.pointee = .haveData
    return input
  }
  if output.frameLength > 0 {
    try? file?.write(from: output)
    framesWritten += AVAudioFramePosition(output.frameLength)
  }
}

var ioProcID: AudioDeviceIOProcID?
check(AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, nil) { _, inputData, inputTime, _, _ in
  let stamp = inputTime.pointee
  let hostTime = stamp.mFlags.contains(.hostTimeValid) ? stamp.mHostTime : mach_absolute_time()
  guard let view = AVAudioPCMBuffer(pcmFormat: tapFormat, bufferListNoCopy: inputData, deallocator: nil),
    let copy = AVAudioPCMBuffer(pcmFormat: tapFormat, frameCapacity: view.frameLength)
  else { return }
  copy.frameLength = view.frameLength
  let source = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: view.audioBufferList))
  let target = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
  for (s, t) in zip(source, target) where s.mData != nil && t.mData != nil {
    memcpy(t.mData, s.mData, Int(min(s.mDataByteSize, t.mDataByteSize)))
  }
  work.async { process(copy, hostTime: hostTime) }
}, "Creating the audio callback")
startHostTime = mach_absolute_time()
emit(["event": "started", "at": Date().timeIntervalSince1970 * 1000])
check(AudioDeviceStart(aggregateID, ioProcID), "Starting the capture")

func stop() -> Never {
  let stoppedAt = mach_absolute_time()
  AudioDeviceStop(aggregateID, ioProcID)
  if let ioProcID { AudioDeviceDestroyIOProcID(aggregateID, ioProcID) }
  AudioHardwareDestroyAggregateDevice(aggregateID)
  AudioHardwareDestroyProcessTap(tapID)
  work.sync {
    padSilence(upTo: seconds(sinceStart: stoppedAt))
    // close() is macOS 15+; before that the WAV header is finalized when the
    // file object is released.
    if #available(macOS 15.0, *) { file?.close() }
    file = nil
  }
  emit(["event": "stopped", "seconds": Double(framesWritten) / outFormat.sampleRate])
  exit(0)
}

// Stop on stdin EOF (the app closing our stdin) or a termination signal.
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let signalSources = [SIGTERM, SIGINT].map { sig -> DispatchSourceSignal in
  let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  source.setEventHandler { stop() }
  source.resume()
  return source
}
Thread.detachNewThread {
  while let _ = readLine(strippingNewline: false) {}
  DispatchQueue.main.async { stop() }
}
_ = signalSources
dispatchMain()
