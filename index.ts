/**
 * v100-media — media tools for the V100 node (192.168.1.10) + local voice input.
 *
 * 1. transcribe_audio tool (+ /transcribe command) → faster-whisper on GPU0, port 18080 (~10x realtime)
 * 2. Auto-transcription: audio file paths in a user prompt are replaced with the recognized text
 *    (if there was text around the path, the transcription takes the place of the path)
 * 3. Voice note: Ctrl+N or F9 — record from microphone via ffmpeg (dshow), transcribe on V100,
 *    insert the result as a user prompt. A copy is kept in ~/.pi/agent/voicenotes/.
 *    Works on any keyboard layout (matching is by physical key / control code, not character).
 *
 * Env overrides:
 *   V100_HOST      — default http://192.168.1.10
 *   V100_FFMPEG    — ffmpeg path, default C:\bin\ffmpeg.exe
 *   V100_MIC_DEVICE— substring to pick a specific input device (default: first found)
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";

const V100_HOST = process.env.V100_HOST ?? "http://192.168.1.10";
const WHISPER_PORT = 18080;
const MAX_FILE_BYTES = 500 * 1024 * 1024;

// forward slashes on purpose: this Node build fails with backslash paths (ENOENT)
const FFMPEG = process.env.V100_FFMPEG ?? "C:/bin/ffmpeg.exe";
const MIC_DEVICE_HINT = (process.env.V100_MIC_DEVICE || "").toLowerCase();
const VOICENOTES_DIR = path.join(os.homedir(), ".pi", "agent", "voicenotes");
// Voice-note noise filter: low-confidence short recordings are usually silence/noise
const LOW_CONFIDENCE = 0.5;   // below this — mark as unreliable
const NOISE_MAX_SEC = 3;      // …and ≤ this duration → discard outright

// Minimal structural type for the shortcut handler context (jiti erases types; keep it honest)
type VoiceCtx = {
  ui: {
    notify(msg: string, kind?: "info" | "error"): void;
    setStatus(id: string, text?: string): void;
  };
  isIdle(): boolean;
};

interface TranscribeResult {
  text: string;
  language: string;
  probability: number;
  audio_duration: number;
  elapsed: number;
}

// ---------- whisper client (GPU0, port 18080) ----------

async function transcribeBuffer(buf: Buffer, filename: string, language?: string): Promise<TranscribeResult> {
  const form = new FormData();
  form.append("file", new Blob([buf]), filename);
  const qs = language ? `?language=${encodeURIComponent(language)}` : "";
  const url = `${V100_HOST}:${WHISPER_PORT}/transcribe${qs}`;
  // Transcription runs ~10x realtime; allow headroom for model warmup and queueing.
  const res = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(300_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`whisper service ${url} returned HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as TranscribeResult;
}

async function transcribeFile(absPath: string, language?: string): Promise<TranscribeResult> {
  const buf = await fs.readFile(absPath);
  return transcribeBuffer(buf, path.basename(absPath), language);
}

// ---------- audio paths in prompts → replace with transcription ----------

const AUDIO_EXT_RE = /\.(wav|mp3|m4a|aac|ogg|oga|opus|flac|webm|mp4|mov|wma)$/i;

async function replaceAudioPaths(
  text: string,
  cwd: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  const candidates = new Set<string>();
  for (const raw of text.split(/\s+/)) {
    const tok = raw.replace(/^['"([{<]+|['"\])}>.,;:!?]+$/g, "");
    if (!tok || !AUDIO_EXT_RE.test(tok) || !(/[/\\]/.test(tok) || /^[A-Za-z]:/.test(tok))) continue;
    candidates.add(tok);
  }
  let out = text;
  for (const tok of candidates) {
    const abs = path.resolve(cwd, tok);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      continue; // not a real file — leave as-is
    }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
    let replacement: string;
    try {
      onProgress?.(`Transcribing ${tok}…`);
      const r = await transcribeFile(abs);
      replacement = r.text ? `"${r.text}"` : `[no speech detected in ${tok}]`;
    } catch (e) {
      replacement = `[audio transcription failed for ${tok}: ${e instanceof Error ? e.message : String(e)}]`;
    }
    out = out.split(tok).join(replacement);
  }
  return out;
}

// ---------- microphone recording via ffmpeg dshow ----------

interface RecState {
  proc: ChildProcessWithoutNullStreams;
  file: string;
  device: string;
  startedAt: number;
  exited: boolean;
  code: number | null;
  stderr: string;
}

let rec: RecState | null = null;
let processing = false; // stop→transcribe phase in progress (ignore extra key presses)
let deviceCache: string[] | null = null;

function listAudioDevices(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      FFMPEG,
      ["-hide_banner", "-f", "dshow", "-list_devices", "true", "-i", "dummy"],
      { timeout: 8000 },
      (err, _stdout, stderr) => {
        if (err && !stderr) return resolve([]);
        const devices: string[] = [];
        let inAudioSection = false; // legacy ffmpeg format
        for (const line of String(stderr).split(/\r?\n/)) {
          // modern ffmpeg: "Device Name" (audio)
          const m2 = line.match(/^\s*\[in#\d+ @ [^\]]+\]\s+"(.+)"\s+\(audio\)/);
          if (m2) {
            devices.push(m2[1]);
            continue;
          }
          // legacy ffmpeg: "DirectShow audio devices" section with [0] Name lines
          if (/DirectShow audio devices/i.test(line)) inAudioSection = true;
          else if (/DirectShow video devices/i.test(line)) inAudioSection = false;
          if (inAudioSection) {
            const m1 = line.trim().match(/^\[\d+\]\s+(.+)$/);
            if (m1) devices.push(m1[1]);
          }
        }
        resolve(devices);
      }
    );
  });
}

function startRecording(device: string): RecState {
  const file = path.join(os.tmpdir(), `v100-mic-${Date.now()}.wav`);
  const proc = spawn(
    FFMPEG,
    // no shell on Windows → pass the device name WITHOUT literal quotes (ffmpeg would match them as part of the name)
    ["-hide_banner", "-loglevel", "error", "-f", "dshow", "-i", `audio=${device}`, "-ar", "16000", "-ac", "1", "-y", file],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
  );
  const state: RecState = { proc, file, device, startedAt: Date.now(), exited: false, code: null, stderr: "" };
  proc.stderr.on("data", (d) => {
    state.stderr = (state.stderr + d.toString()).slice(-2048);
  });
  proc.on("close", (code) => {
    state.exited = true;
    state.code = code;
  });
  return state;
}

async function stopRecorder(state: RecState): Promise<void> {
  // 'q' on stdin = graceful ffmpeg quit → WAV header finalized. (SIGTERM is unreliable on Windows.)
  try {
    state.proc.stdin.write("q");
  } catch {
    /* already closed */
  }
  if (!state.exited) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => resolve(), 5000);
      state.proc.once("close", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  if (!state.exited) state.proc.kill(); // fallback: hard kill
}

// ---------- extension ----------

export default function (pi: ExtensionAPI) {
  // Tool for the model
  pi.registerTool({
    name: "transcribe_audio",
    label: "Transcribe Audio",
    description:
      "Transcribes an audio file to text via faster-whisper on the V100 server (~10x realtime). " +
      "Use when the user references a voice memo or audio file (wav/mp3/m4a/ogg/flac) and its spoken content is needed. " +
      "Note: plain paths in user prompts may already be auto-transcribed.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the audio file" }),
      language: Type.Optional(
        Type.String({ description: 'Language code like "ru" or "en"; omit for auto-detect' })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const abs = path.resolve(process.cwd(), params.path);
        await fs.stat(abs);
        const r = await transcribeFile(abs, params.language);
        const speedup = (r.audio_duration / Math.max(r.elapsed, 0.01)).toFixed(0);
        return {
          content: [
            { type: "text", text: `Transcribed ${r.audio_duration}s audio (${r.language}, ${speedup}x realtime):\n\n${r.text}` },
          ],
          details: { language: r.language, probability: r.probability, elapsed: r.elapsed, audio_duration: r.audio_duration },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `transcribe_audio failed: ${msg}` }], details: {}, isError: true };
      }
    },
  });

  // Direct command (no LLM involved)
  pi.registerCommand("transcribe", {
    description: "Transcribe an audio file via V100 whisper (args: <path> [language])",
    handler: async (args, ctx) => {
      const [p, lang] = (args ?? "").trim().split(/\s+/);
      if (!p) return ctx.ui.notify("Usage: /transcribe <audio-path> [language]", "info");
      try {
        const r = await transcribeFile(path.resolve(ctx.cwd, p), lang);
        ctx.ui.notify(`[${r.language}] ${r.text}`, "info");
      } catch (err) {
        ctx.ui.notify(`Transcribe failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  // Auto-transcription: replace audio file paths in user prompts with recognized text
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return undefined; // don't reprocess injected messages
    const transformed = await replaceAudioPaths(
      event.text,
      ctx.cwd,
      ctx.hasUI ? (m) => ctx.ui.notify(m, "info") : undefined
    );
    if (transformed !== event.text && ctx.hasUI) {
      ctx.ui.notify("Audio path(s) in prompt replaced with transcription", "info");
    }
    return transformed !== event.text ? { action: "transform" as const, text: transformed } : undefined;
  });

  // Voice note hotkey: toggle recording → transcribe → insert as user prompt.
  // ctrl+n: free in pi's editor, unique control byte (0x0E) — safe even in legacy terminals
  //         where Kitty protocol is off (there ctrl+m == Enter, hence avoided).
  // f9: zero-ambiguity one-key alternative.
  const handleVoiceNote = async (ctx: VoiceCtx) => {
    if (!rec) {
      // --- start recording ---
      try {
        let devices = deviceCache;
        if (!devices) {
          ctx.ui.setStatus("voice", "🎙 Looking for microphone…");
            devices = await listAudioDevices();
            deviceCache = devices;
          }
          const chosen = MIC_DEVICE_HINT
            ? devices.find((d) => d.toLowerCase().includes(MIC_DEVICE_HINT))
            : undefined;
          const device = chosen ?? devices[0];
          if (!device) throw new Error("no audio input devices found (check V100_FFMPEG / V100_MIC_DEVICE)");
        rec = startRecording(device);
        ctx.ui.setStatus("voice", "🎙 Recording… (Ctrl+N / F9 to stop)");
        ctx.ui.notify(`Recording from: ${device}`, "info");
      } catch (e) {
        rec = null;
        ctx.ui.setStatus("voice", undefined);
        ctx.ui.notify(`Mic error: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
      return;
    }

      // --- stop recording, transcribe, insert as prompt ---
      const state = rec;
      rec = null;
      processing = true;
      await stopRecorder(state);

      let buf: Buffer | null = null;
      try {
        buf = await fs.readFile(state.file);
      } catch {
        /* file missing */
      }
      const seconds = buf ? buf.length / (16000 * 2) : 0;
      if (!buf || seconds < 0.5) {
        processing = false;
        ctx.ui.setStatus("voice", undefined);
        ctx.ui.notify(
          state.code === 0
            ? `Recording too short (${seconds.toFixed(1)}s) — discarded`
            : `ffmpeg exited with code ${state.code}: ${state.stderr.slice(-300)}`,
          "error"
        );
        await fs.unlink(state.file).catch(() => {});
        return;
      }

      ctx.ui.setStatus("voice", `⏳ Transcribing voice note (${seconds.toFixed(0)}s)…`);
      try {
        const r = await transcribeBuffer(buf, path.basename(state.file));
        // keep a copy in the voicenotes archive
        await fs.mkdir(VOICENOTES_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
        const archived = path.join(VOICENOTES_DIR, `rec-${stamp}.wav`);
        await fs.copyFile(state.file, archived).catch(() => {});
        if (r.text) {
          const p = r.probability ?? 1;
          if (p < LOW_CONFIDENCE && seconds <= NOISE_MAX_SEC) {
            // Almost certainly silence/background noise — don't spam the model
            ctx.ui.notify(`🔇 Voice note discarded as noise («${r.text}», conf ${p.toFixed(2)}, ${seconds.toFixed(0)}s). Copy: ${archived}`, "info");
          } else if (p < LOW_CONFIDENCE) {
            // Long enough to be real speech, but whisper isn't sure — let the model judge
            ctx.ui.notify(`Voice note with low confidence (${p.toFixed(2)}) — inserted with a marker. Copy: ${archived}`, "info");
            pi.sendUserMessage(
              `[voice note, low confidence ${p.toFixed(2)}] ${r.text}`,
              ctx.isIdle() ? undefined : { deliverAs: "followUp" }
            );
          } else {
            ctx.ui.notify(`Voice note (${r.language}, ${seconds.toFixed(0)}s) → ${archived}`, "info");
            pi.sendUserMessage(r.text, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
          }
        } else {
          ctx.ui.notify("No speech detected", "info");
        }
      } catch (e) {
        ctx.ui.notify(`Transcribe failed (${state.file} kept): ${e instanceof Error ? e.message : String(e)}`, "error");
        processing = false;
        ctx.ui.setStatus("voice", undefined);
        return; // keep temp file for debugging
      }
      processing = false;
      ctx.ui.setStatus("voice", undefined);
      await fs.unlink(state.file).catch(() => {});
    };

  pi.registerShortcut("ctrl+n", {
    description: "Voice note: record from mic / stop and transcribe (V100 whisper)",
    handler: async (ctx) => {
      if (processing) {
        ctx.ui.notify("Still processing previous voice note…", "info");
        return;
      }
      // immediate marker, before any await
      if (!rec) ctx.ui.setStatus("voice", "🎙 Starting…");
      await handleVoiceNote(ctx);
    },
  });
  pi.registerShortcut("f9", {
    description: "Voice note (alt): record from mic / stop and transcribe",
    handler: async (ctx) => {
      if (processing) {
        ctx.ui.notify("Still processing previous voice note…", "info");
        return;
      }
      if (!rec) ctx.ui.setStatus("voice", "🎙 Starting…");
      await handleVoiceNote(ctx);
    },
  });
}
