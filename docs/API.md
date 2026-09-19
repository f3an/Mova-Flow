# HTTP API

Reference for the endpoints `server.ts` exposes on the host (typically `http://<host>:5000`). This is the internal protocol between a Mova Flow client and host, not a public API — every request except `/` and `/api/auth` requires a bearer token (see [ARCHITECTURE.md → Security model](ARCHITECTURE.md#security-model)).

Ground rules for every route:

- CORS is wide open (`Access-Control-Allow-Origin: *`) — the renderer always loads from `file://`, so every `fetch()` is cross-origin; the preflight (`OPTIONS`) request is handled explicitly.
- `/api/*` is capped at 120 requests per 5 minutes per IP; `/api/auth` has its own, stricter limit of 5 requests per minute per IP.
- Errors come back as `{ "error": "..." }` with the matching HTTP status.

## `GET /`

Liveness check. No authentication.

**`200` response:**
```json
{ "ok": true }
```

## `POST /api/auth`

Exchanges the shared secret for a short-lived bearer token.

**Request body:**
```json
{ "secret": "x7K2m9QpLr4vT8wZ1nF6cJ3hY5sD0aE" }
```

**`200` response:**
```json
{ "token": "<base64url header>.<base64url payload>.<base64url signature>", "expiresAt": 1758312345 }
```

**`401` response** — the secret is missing or doesn't match (`timingSafeEqualStr`):
```json
{ "error": "Invalid secret key." }
```

The token is a minimal hand-rolled HS256 JWT (`alg`, `typ`, `exp`) signed with that same secret; TTL is 12 hours. For its own Upload tab, the host gets a token directly over IPC (`window.api.get_token()`), bypassing this route entirely.

## `POST /api/transcribe`

Queues a file for recognition. Requires `Authorization: Bearer <token>`.

**Request body** — `multipart/form-data`:

| Field | Type | Description |
|---|---|---|
| `file` | File | audio file, `.mp3 .wav .ogg .flac` (anything else is rejected with `400`) |
| `language` | string | a language code, or `auto` (the default) |

**`200` response:**
```json
{ "job_id": "a1b2c3d4e5f6" }
```

**`400` response** — no file, or an unsupported extension:
```json
{ "error": "Unsupported format: .aac. Allowed: .flac, .mp3, .ogg, .wav" }
```

The job runs asynchronously (`runJob()` in the background); progress is read back via `/api/status/:id`.

## `GET /api/status/:id`

Job status. Requires a token.

**`200` response**, while running:
```json
{ "status": "processing", "progress": "Processed segments: 12", "filename": "meeting.mp3" }
```

**`200` response**, once finished (`result` is only present in the `done` state):
```json
{
  "status": "done",
  "progress": "Done.",
  "filename": "meeting.mp3",
  "detectedLanguage": "en",
  "result": "[00:00] Good afternoon...\n[00:04] ..."
}
```

**`404` response** — unknown or forgotten `job_id` (the server was restarted — `jobs` only lives in the process's memory).

## `GET /api/download/:id`

The transcript as a `.txt` file. Requires a token.

- For a host job (`isLocal`), it reads `transcripts/<id>.txt` from disk.
- For a network job, it serves the text straight from memory (the `jobs` map) — it's never written to disk at all.

**`200` response** — `Content-Disposition: attachment; filename="transcript_<id>.txt"`.

**`404` response** — the transcript isn't ready yet, or `id` failed the `^[a-f0-9]{1,32}$` check.

---

The four routes below are further restricted by `requireLocal` — reachable **only** from `127.0.0.1`/`::1`, even with a valid token (see [ARCHITECTURE.md](ARCHITECTURE.md#security-model)). A client machine gets `403` on every one of these, which is why it keeps its own history separately, over IPC.

## `GET /api/history`

The host's local job list, newest first.

**`200` response:**
```json
{
  "items": [
    { "id": "a1b2c3d4e5f6", "filename": "standup.mp3", "language": "en", "createdAt": 1758312345000, "audioExt": ".mp3" }
  ]
}
```

## `GET /api/history/:id/text`

**`200` response:**
```json
{ "text": "[00:00] ..." }
```

**`404` response** — `id` failed validation, or `transcripts/<id>.txt` is missing.

## `GET /api/history/:id/audio`

Returns the raw audio file (`Content-Type` by extension: `audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/flac`).

**`404` response** — the entry isn't in `history.json`, or the file is missing from disk.

## `DELETE /api/history/:id`

Deletes the entry and its files (`audio/<id><ext>`, `transcripts/<id>.txt`).

**`200` response:**
```json
{ "ok": true }
```

**`404` response** — the entry wasn't found.

---

## Error codes

| Status | When |
|---|---|
| `400` | no file in the request, unsupported extension |
| `401` | missing/wrong secret (`/api/auth`), missing/invalid/expired token (everything else) |
| `403` | a request to `/api/history*` came from somewhere other than `127.0.0.1` |
| `404` | job/transcript/audio/history entry not found, or `id` failed the `^[a-f0-9]{1,32}$` format check |
| `429` | rate limit exceeded (120/5min on `/api`, 5/min on `/api/auth`) |
