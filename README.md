# v100-media

Media tools for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent): audio transcription via a **faster-whisper** service on a V100 GPU node, plus full local voice input. Four features in one extension, no npm dependencies (Node builtins + system ffmpeg).

## Features

1. **`transcribe_audio` tool** — the model can transcribe any local audio file itself:
   ```
   Transcribed 2.9s audio (ru, 8x realtime):
   Привет, как дела? Сервер работает нормально.
   ```
2. **Auto-transcription of paths in prompts** — if you paste an audio path into a message, it is replaced with the recognized text *before* the LLM sees it:
   ```
   > Аудио: C:/Users/me/voice/memo.wav
   → model receives: Аудио: "Привет, как дела?"
   ```
3. **`/transcribe <path> [language]`** — direct command, no LLM round-trip; result shown as a notification.
4. **Voice notes (Ctrl+N or F9)** — press to start recording from the microphone, press again to stop. The audio is transcribed on the GPU and **pasted into the input field** — you review it and press Enter yourself. A copy of every recording is archived in `~/.pi/agent/voicenotes/rec-*.wav`.

## Requirements

- **ffmpeg** on PATH or at a known location (Windows: DirectShow input, `-f dshow`).
  Default: `C:/bin/ffmpeg.exe` — override with `V100_FFMPEG`.
- A **whisper HTTP service** listening on port **18080**:
  - `GET /health` → `{ "status": "ok", "model_loaded": true, ... }`
  - `POST /transcribe?language=<optional>` — multipart field `file`; returns
    `{ text, language, probability, audio_duration, elapsed }`.

  Reference implementation: faster-whisper (`large-v3-turbo`, `int8_float16`) + Flask on the same GPU as the LLM (~1.3 GB VRAM, ~10× realtime). The service is expected to be resident; a cold model load is tolerated (request timeout is 300 s).

## Installation

Copy (or clone) this folder into Pi's global extensions directory:

```
~/.pi/agent/extensions/v100-media/
    index.ts
    LICENSE
    README.md
```

No build step, no `package.json` — the extension uses only Node builtins. Restart Pi or `/reload`.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `V100_HOST` | `http://192.168.1.10` | Base URL of the whisper host (port 18080 is appended) |
| `V100_FFMPEG` | `C:/bin/ffmpeg.exe` | Path to ffmpeg. **Use forward slashes** — this Node build fails with backslash paths (`ENOENT`) |
| `V100_MIC_DEVICE` | *(empty)* | Substring used to pick a specific input device; default is the first found |

## How it works

### Whisper client

Files are read locally and uploaded as multipart/form-data (the file never needs to exist on the server). Hard limit: **500 MB** per file. Accepted extensions for auto-replacement: `wav mp3 m4a aac ogg oga opus flac webm mp4 mov wma` (anything with an audio track works — ffmpeg/whisper decode it).

### Auto-transcription of prompt paths

An `input` hook scans the user message for path-like tokens ending in an audio extension, resolves them against the cwd, and replaces each existing file (≤ 500 MB) with its transcription wrapped in quotes. A "Transcribing …" notification is shown per file so it doesn't look like a hang. Messages injected by extensions (`event.source === "extension"`) are skipped to avoid reprocessing voice notes.

### Voice notes

- Recording: `ffmpeg -f dshow -i audio=<device> -ar 16000 -ac 1` → temp WAV. The device name is passed **without** quotes (no shell), and ffmpeg's modern *and* legacy `-list_devices` output formats are parsed.
- Stop: a `q` is written to ffmpeg's stdin for a graceful quit (WAV header finalized); SIGTERM alone is unreliable on Windows, so a hard kill is the fallback after 5 s.
- Recordings shorter than ~0.5 s are discarded as accidental taps.
- **Noise filter**: whisper reports a confidence per result. If `probability < 0.5` *and* duration ≤ 3 s → almost certainly silence/background noise: the note is discarded (but archived) and the model isn't spammed. If it's longer but still low-confidence, it is inserted with a `[voice note, low confidence X]` marker so the model can judge for itself.
- The result is pasted into the editor via `ctx.ui.pasteToEditor()` (inserts at the cursor, doesn't clobber existing input) — sending stays manual. In non-TUI modes (`pi -p`, json) there is no editor, so it falls back to `pi.sendUserMessage()`, using a **followUp** delivery while Pi is busy.
- Status markers live in the footer (`ctx.ui.setStatus("voice", …)`): 🎙 Starting… → Looking for microphone… → Recording… (Ctrl+N / F9 to stop) → ⏳ Transcribing voice note (Ns)… — plus a `processing` guard so double presses during stop→transcribe are ignored.

### Why Ctrl+N and F9

In legacy terminal mode (no Kitty keyboard protocol) `Ctrl+M` is physically the same byte as Enter (`\r`) — it would trigger on every Enter press. `Ctrl+N` has a unique control byte (`0x0E`) that Pi's editor doesn't use, and `F9` is an unambiguous one-key alternative. Both work regardless of keyboard layout (matched by physical key / control code, not character).
