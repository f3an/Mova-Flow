# Contributing to Mova Flow

## Prerequisites

- Node.js 22+
- Windows, if you want to actually test the host role end-to-end (`whisper-cli.exe`, PowerShell `Expand-Archive`, `nvidia-smi` — see [docs/ARCHITECTURE.md → Platform constraints](docs/ARCHITECTURE.md#platform-constraints)). macOS/Linux work fine for UI and client-role changes.

## Setup

```bash
npm install
npm run dev   # build + launch Electron
```

Other useful commands:

```bash
npm run typecheck   # tsc --noEmit
npm run build         # main (tsc) + renderer (esbuild)
npm run dist            # build + electron-builder → release/
```

CI runs `typecheck` and `build` on both Windows and Ubuntu for every push and pull request against `master` (see `.github/workflows/ci.yml`).

## Before opening a PR

- `npm run typecheck` and `npm run build` both pass.
- If you touched `src/main/server.ts`, update [docs/API.md](docs/API.md) to match.
- If you changed a process boundary, the auth flow, or the file pipeline, update [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (and its diagrams under `docs/diagrams/`, hand-authored SVG — no Mermaid).
- If you touched the renderer, add or update the matching string in `src/renderer/i18n.ts`'s `UK` table — English lives inline in the code as the fallback (see the comment at the top of `i18n.ts`), Ukrainian only ever lives in that table.

## Code style

- No comments that restate what the code does — only ones that explain a non-obvious *why* (see the existing codebase for the tone: short, dry, placed right where the surprise is).
- Keep changes scoped to what the task needs; avoid speculative abstractions or unrelated refactors in the same PR.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`), matching the existing history.

## Reporting bugs / requesting features

Use the issue templates. For anything security-related, see [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Cutting a release

1. Bump `"version"` in `package.json` (it drives the installer filenames, e.g. `Mova-Flow-Setup-1.1.0.exe`).
2. Commit that (`chore: bump version to 1.1.0`), merge to `master`.
3. Tag it and push the tag:
   ```bash
   git tag v1.1.0
   git push origin v1.1.0
   ```
4. [`.github/workflows/release.yml`](.github/workflows/release.yml) builds the Windows `.exe` and macOS `.dmg` and publishes them as a GitHub release, with GitHub's automatic source `.zip`/`.tar.gz` attached alongside. You can also run it manually from the Actions tab (`workflow_dispatch`) without a tag to sanity-check a build.
