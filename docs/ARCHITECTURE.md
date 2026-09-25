# Mova Flow architecture

This document covers the app's internals: the Electron process model, the audio transcription pipeline, the security model, and the on-disk data layout. For a general overview and quick start, see [README.md](../README.md).

## Contents

- [Electron processes](#electron-processes)
- [Transcription pipeline](#transcription-pipeline)
- [Security model](#security-model)
- [On-disk data](#on-disk-data)
- [Audio formats](#audio-formats)
- [Network discovery](#network-discovery)
- [Updates](#updates)
- [Platform constraints](#platform-constraints)

## Electron processes

The app is the usual three Electron layers plus a built-in HTTP server, which is what makes the "one server, many clients" setup possible over the network:

```mermaid
flowchart TB
    subgraph UI["Renderer process (Chromium, sandboxed)"]
        R["index.html + renderer.ts<br/>Upload / History / Server tabs · i18n.ts"]
    end

    subgraph PL["Preload"]
        P["preload/index.ts<br/>contextBridge.exposeInMainWorld('api', …)"]
    end

    subgraph MAIN["Main process (Node.js) — main/index.ts"]
        C["Config<br/>readConfig() / writeConfig()<br/>role, port, auth_secret, model, lan_expose"]
        H["HTTP API<br/>server.ts — Express + ServerController<br/>/api/auth /api/transcribe /api/status /api/history…"]
        E["Recognition engine<br/>engine.ts<br/>ensureEngine() downloads whisper-cli + ggml model<br/>transcribe() spawns the CLI"]
    end

    FS["userData directory<br/>config.json · history.json<br/>engine/ (CLI + model .bin)<br/>uploads/ · transcripts/ · audio/"]
    NET["Network<br/>this machine's own Upload tab (loopback) +<br/>other LAN devices, if exposed"]
    CLI["whisper-cli<br/>child process (whisper.cpp)<br/>reads the ggml-*.bin model<br/>prints timestamped segments"]

    R <-->|"window.api.*() → ipcRenderer.invoke(channel, …)"| P
    P <-->|"ipcMain.handle(channel, …)"| MAIN
    H -->|calls| E
    C <--> FS
    H -->|"serves :{port}"| NET
    E -->|"spawn(-m,-f,-l)"| CLI
    CLI -->|"stdout: segments"| E
```

- **Renderer** (`src/renderer/`) — an ordinary sandboxed Chromium page (`nodeIntegration: false`, `contextIsolation: true`). No direct access to Node.js or the filesystem; everything goes through `window.api`.
- **Preload** (`src/preload/index.ts`) — the only bridge between the renderer and the main process. Via `contextBridge.exposeInMainWorld` it publishes an `api` object (thin wrappers around `ipcRenderer.invoke`) and a `platform` string (only needed for the CSS padding under macOS's traffic-light buttons).
- **Main** (`src/main/index.ts`) — owns the window, `config.json`, every `ipcMain.handle` handler, and starts/stops the HTTP server (`ServerController` in `server.ts`).
- **HTTP API** (`src/main/server.ts`) — an Express server listening on `127.0.0.1` (or `0.0.0.0` once "Expose to local network" is turned on) that serves both the host's own Upload tab (always over loopback) and requests from client machines on the network.
- **Recognition engine** (`src/main/engine.ts`) — downloads the whisper.cpp binary (Windows) or pulls it from GitHub Packages (macOS — see [Platform constraints](#platform-constraints)) and the model, then spawns `whisper-cli` as a child process for each job.

The renderer never talks to `whisper-cli` or the filesystem directly — every command travels `renderer → preload (IPC) → main → HTTP API → engine → child process`.

## Transcription pipeline

The path from a dropped file to a finished history entry:

```mermaid
flowchart TD
    A["Browser — Upload tab<br/>user drops or picks an audio file (renderer.ts)"]
    B["Format check + in-browser conversion<br/>.mp3/.wav/.ogg/.flac → sent unchanged (whisper-cli reads via miniaudio)<br/>.m4a/.mov → decodeAudioData → OfflineAudioContext → 16kHz mono → encodeWav()<br/><i>prepareFileForUpload() — no server-side conversion exists</i>"]
    C["POST /api/transcribe — server.ts<br/>multipart file + Authorization: Bearer &lt;token&gt;<br/>rateLimiter → requireAuth → extension allow-list → multer saves to uploads/<br/><i>responds immediately with { job_id }; work continues in runJob()</i>"]
    D["runJob() spawns whisper-cli — engine.ts<br/>args: -m &lt;model.bin&gt; -f &lt;file&gt; -l &lt;lang|auto&gt;<br/>stdout parsed live: SEGMENT_RE, LANG_RE<br/>each match streamed back as job.progress<br/><i>exit code 0 but &quot;failed to read audio&quot; in stderr ⇒ rejected anyway</i>"]
    E{"request from<br/>127.0.0.1?<br/>isLoopback(req.ip)"}
    F["Local job (this machine's own tab)<br/>write transcripts/&lt;id&gt;.txt<br/>move audio → audio/&lt;id&gt;.ext<br/>prepend entry to history.json<br/>→ shows up in the History tab"]
    G["Remote job (another LAN device)<br/>delete the temp upload file<br/>no transcript file, no history entry<br/>result kept only in the in-memory jobs map, for this run only"]
    H["Client side<br/>polls GET /api/status/:id every 1.5s until 'done', then GET /api/download/:id<br/><i>a client machine also mirrors the finished text into its own clientHistory.ts over IPC</i>"]

    A --> B --> C --> D --> E
    E -->|yes| F
    E -->|no| G
    F --> H
    G --> H
```

Key details:

1. **Conversion happens in the browser, not on the server.** `whisper-cli` can only read `.mp3 .wav .ogg .flac` (the formats its bundled `miniaudio` supports). `.m4a`/`.mov` files are converted to 16kHz mono WAV right in the renderer via `decodeAudioData` → `OfflineAudioContext` → a hand-written 44-byte WAV header (`encodeWav()` in `renderer.ts`). The server has no converter of its own.
2. **Progress streams without websockets.** `whisper-cli` writes segments to stdout as it recognizes them. `engine.ts` parses each line with regular expressions (`SEGMENT_RE`, `LANG_RE`) and updates `job.progress` in memory; the client polls `GET /api/status/:id` every 1.5s.
3. **Local job vs. a job from the network.** `server.ts` tells the two apart with `isLoopback(req.ip)`. If the request came from the host itself (the host's own Upload tab always goes through `127.0.0.1`), the result is saved to `history.json`, the audio is moved into `audio/`, and the text is written to `transcripts/`. If the request came from another machine on the network, the temp file is deleted, no host-side history entry is created, and the text lives only in memory (the `jobs` map) for as long as the server process runs.
4. **The client keeps its own history.** Since the host remembers nothing about network jobs, a client-role Mova Flow saves the audio + text locally itself, through `clientHistory.ts` (IPC, not HTTP), once the result comes back — so the History tab still works on the client side.

## Security model

```mermaid
sequenceDiagram
    participant Client as Client machine<br/>(role: client — UI only)
    participant Host as Host machine<br/>(role: host — server.ts on :5000)

    Client->>Host: ① POST /api/auth { secret }
    Note over Client,Host: secret copied once from the host's Server tab → Access secret key
    Host-->>Client: ② 200 { token, expiresAt }
    Note over Host,Client: HS256 token, timingSafeEqual check, 12h TTL

    Client->>Host: ③ POST /api/transcribe<br/>Authorization: Bearer &lt;token&gt;, multipart audio file
    activate Host
    Note right of Host: ④ rateLimiter → requireAuth → multer<br/>saves to uploads/, then spawns whisper-cli
    Host-->>Client: ⑤ 200 { job_id }
    deactivate Host

    loop every 1.5s until status is "done" or "error"
        Client->>Host: ⑥ GET /api/status/:job_id
        Host-->>Client: { status } → … → { status: "done", result }
    end

    Client->>Host: ⑦ GET /api/download/:job_id
    Host-->>Client: ⑧ 200 transcript_&lt;id&gt;.txt

    Note over Host: requireLocal — /api/history*<br/>any request whose IP isn't 127.0.0.1 gets 403,<br/>even with a valid token
```

*All requests carry CORS + preflight headers — the renderer loads from `file://`, so every `fetch()` is cross-origin.*

- **A shared secret, not a user password.** The host generates an `auth_secret` (24 random bytes, base64url) on first launch and shows it on the Server tab. Every client enters that same string once, when setting up the connection.
- **Short-lived bearer tokens.** `POST /api/auth` exchanges the secret for an HS256 token (`auth.ts`, a minimal hand-rolled implementation with no external library) with a 12-hour TTL. Every subsequent request (`/api/transcribe`, `/api/status/:id`, `/api/download/:id`) requires an `Authorization: Bearer <token>` header, checked by `requireAuth`.
- **Timing-safe comparisons.** Both the secret check and the token signature check go through `timingSafeEqualStr` (`crypto.timingSafeEqual` with a length pre-check) so the secret can't be recovered via a timing attack.
- **History is loopback-only, regardless of the token.** `requireLocal` in `server.ts` returns `403` for any request whose IP isn't `127.0.0.1`/`::1` — even with a valid bearer token. That means the host's history is physically unreachable from the network, by anyone but the host itself.
- **In-memory rate limiting.** A simple fixed-window counter (`rateLimit.ts`), with a stricter limit specifically on `/api/auth` (5 attempts/minute per IP) to slow down secret brute-forcing.
- **Network exposure is opt-in.** The server binds to `127.0.0.1` by default; binding to `0.0.0.0` (and thus being reachable on the LAN) only happens when "Expose to local network" is explicitly turned on, on the Server tab.

## On-disk data

Everything lives under `app.getPath('userData')` (the OS's per-user app profile), never next to the app itself:

```
userData/
  config.json               role, host/port, secrets, chosen model, lan_expose
  engine/
    bin/Release/whisper-cli.exe   the whisper.cpp binary (Windows; downloaded once)
    bin/whisper-cli                the whisper.cpp binary (macOS; downloaded once)
    ggml-<preset>.bin              the chosen model (or the user's own file)
  uploads/                   temp files while a job is being processed (multer)
  transcripts/<id>.txt        finished transcripts — host's local jobs only
  audio/<id><ext>              original audio — host's local jobs only
  history.json                the host's local job list (newest first)
  client-history.json          the client's own history (client role)
  client-audio/, client-transcripts/   the client history's audio and text
```

Record IDs are 12-character hex strings (`randomUUID().replace(/-/g,'').slice(0,12)`); every filesystem path built from a user-supplied ID is checked against `^[a-f0-9]{1,32}$` before it's used.

## Audio formats

| Extension | Handling |
|---|---|
| `.mp3 .wav .ogg .flac` | sent unchanged — `whisper-cli` reads these directly via `miniaudio` |
| `.m4a .mov` | re-encoded in the browser to 16kHz mono WAV before upload (`prepareFileForUpload()`) |
| anything else | rejected by the server (`400 Unsupported format`) before `whisper-cli` ever runs |

## Network discovery

`src/main/discovery.ts` wraps `bonjour-service` (mDNS/DNS-SD — the same protocol AirDrop and network printers use) so a client doesn't have to know the host's IP up front:

- **Host**: while `startServer()` is running with `lan_expose` on, it publishes a service under both its own machine name and a fixed `mova-flow.local` alias. The alias exists because a browser extension has no mDNS API to browse with (see [mova-flow-meet-recorder](https://github.com/f3an/mova-flow-meet-recorder)) — it can only ever try one well-known address directly, never enumerate what's on the network.
- **Client**: the Server tab's **Scan network** button browses for ~2.5s (`discoverHosts()`) and renders whatever answered as clickable cards; picking one fills the same host/port fields manual entry uses. Discovery is pure convenience — it only ever writes into those fields, never bypasses them.
- Only ever active while `lan_expose` is on: a loopback-only host has nothing reachable to advertise, and advertising it anyway would just leak the machine's hostname onto the LAN for no reason.
- Depends on multicast actually reaching both machines — guest Wi-Fi with client isolation and some corporate networks block it, in which case manual IP entry is the only option, same as before this existed.

## Updates

`electron-updater` checks `github.com/f3an/Mova-Flow`'s releases on startup and every 6 hours after (`initAutoUpdater()` in `main/index.ts`), reading the `latest.yml`/`latest-mac.yml` that `release.yml` already publishes alongside each installer — no separate update server.

- **Windows and macOS**: both download silently in the background; once ready, the renderer shows a banner (`get-update-state` IPC, polled every 30s) with a **Restart to update** button that calls `autoUpdater.quitAndInstall()`. The macOS build is signed and notarized (Developer ID cert, imported in `release.yml`), so Squirrel.Mac's signature check against the running app passes.
- Skipped entirely when running unpacked (`app.isPackaged` is false) — `npm run dev` has no `app-update.yml` for `electron-updater` to read, since electron-builder only writes that file during actual packaging.
- The Server tab's **Check for updates** button (bottom, next to the current version) triggers the same `autoUpdater.checkForUpdates()` on demand, rather than waiting for the startup check or the next 6-hour interval — useful right after a new release ships.

The `build.publish` block in `package.json` is what makes electron-builder generate `app-update.yml`/`latest*.yml` in the first place; `npm run dist` still passes `--publish never` so electron-builder never uploads anything itself — that stays the job of `release.yml`'s own `softprops/action-gh-release` step.

## Platform constraints

The **"Server (host)"** role runs on Windows and macOS (Apple Silicon):

- **Windows**: `whisper-cli.exe` is a precompiled whisper.cpp build fetched from the project's own GitHub releases — CUDA or CPU variant, depending on `nvidia-smi` (ships with the NVIDIA driver, no CUDA Toolkit needed). Archive extraction goes through `powershell.exe Expand-Archive`, deliberately, instead of the npm package `extract-zip`, which has an unpatched symlink vulnerability.
- **macOS**: ggml-org/whisper.cpp doesn't publish a macOS binary in its own releases (only Windows zips and an Ubuntu tar.gz), so `.github/workflows/build-whisper-macos.yml` compiles `whisper-cli` from source on an Apple Silicon runner — a single static binary with Metal embedded — and pushes it as a public OCI artifact to GitHub Packages (`ghcr.io/f3an/whisper-cli-macos-arm64:<tag>`) via `oras push`, deliberately not a GitHub Release: the Releases page here stays tag-only (app versions), while this artifact tracks an upstream whisper.cpp build tag on its own schedule. `src/main/ghcr.ts` pulls it back with the anonymous OCI registry flow (token → manifest → blob, no credentials needed since the package is public) and `downloadFile()` handles the actual bytes the same way it does for the Windows build. Archive extraction uses the `unzip` binary that ships with macOS. No discrete GPU is required — Metal (Apple Silicon's integrated GPU) accelerates it automatically.
- Intel Macs and Linux aren't supported for the host role yet — `ensureEngine()` throws a clear error rather than silently falling back to something broken.

The **"Client"** role is a plain UI with no dependency on any of that, so it runs on any OS Electron supports.
