# Security policy

## Scope

Mova Flow is a local-network application: a host machine runs speech recognition and exposes an HTTP API (default `127.0.0.1`, optionally `0.0.0.0` on the LAN when "Expose to local network" is turned on), and client machines connect to it with a shared secret. See [docs/ARCHITECTURE.md → Security model](docs/ARCHITECTURE.md#security-model) for how the secret, bearer tokens, and the loopback-only history endpoints actually work.

Security reports are in scope for:

- Authentication or token handling (`src/main/auth.ts`, `requireAuth`/`requireLocal` in `src/main/server.ts`)
- Path handling around user-supplied IDs (history, transcripts, audio)
- The Electron process boundary (`contextIsolation`, `nodeIntegration`, the `preload` bridge)
- The packaging/update pipeline (`electron-builder` config, the release workflow)

Not in scope: the recognition quality of whisper.cpp itself, or vulnerabilities that require an attacker to already control the host machine (Mova Flow's threat model is "an untrusted device on the same LAN," not "a compromised host").

## Supported versions

Only the latest released version is supported. There's no long-term-support branch at this stage.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a security vulnerability.

Instead, report it privately:

- Preferred: [GitHub Security Advisories](https://github.com/f3an/Mova-Flow/security/advisories/new) for this repository.
- Alternative: email **chernyavskiy2019ios@gmail.com** with a description, reproduction steps, and impact.

Please include:

- The version (or commit) affected, and the role (host/client) it applies to.
- Steps to reproduce, or a minimal PoC.
- What an attacker could actually do with it (e.g. read another user's history, bypass `requireAuth`, escape the renderer sandbox).

We'll acknowledge reports as soon as we can and follow up once a fix is available. Please give us a reasonable window to ship a fix before any public disclosure.
