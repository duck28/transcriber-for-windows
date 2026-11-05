// Preferences, kept in localStorage under the same keys the Mac app uses in UserDefaults.
// The main and Settings windows share them; a change in one is announced to the other with `settings-changed`.

import { backend } from "./backend";
import type { SubtitleStyle, VideoFrameRate } from "./subtitles";

export type Appearance = "system" | "light" | "dark";

export const APPEARANCES: { id: Appearance; title: string }[] = [
  { id: "system", title: "System" },
  { id: "light", title: "Light" },
  { id: "dark", title: "Dark" },
];

/** Whisper models (whisper.cpp format) offered, as files of the `ggerganov/whisper.cpp` Hugging Face repository. */
export type WhisperModel = "turboFast" | "turbo" | "small" | "custom";

export const DEFAULT_WHISPER_REPO = "ggerganov/whisper.cpp";

export const WHISPER_MODELS: { id: WhisperModel; file: string; title: string }[] = [
  { id: "turboFast", file: "ggml-large-v3-turbo-q5_0.bin", title: "Large v3 Turbo – fast (≈ 550 MB)" },
  { id: "turbo", file: "ggml-large-v3-turbo.bin", title: "Large v3 Turbo – full precision (≈ 1.6 GB)" },
  { id: "small", file: "ggml-small.bin", title: "Small (≈ 490 MB)" },
  // Any whisper.cpp model, such as a Swiss German fine-tune converted to ggml.
  { id: "custom", file: "", title: "Custom…" },
];

/** Whisper decoding and live-phrase parameters (Settings › Expert Options). */
export interface WhisperParameters {
  /** 1 decodes greedily, like the Mac app; more searches that many candidates. */
  beamSize: number;
  temperature: number;
  /** Added to the temperature for each retry when decoding fails (up to 1.0); 0 disables retries. */
  temperatureIncrement: number;
  entropyThreshold: number;
  logProbThreshold: number;
  noSpeechThreshold: number;
  suppressBlank: boolean;
  suppressNonSpeech: boolean;
  /** 0 picks automatically. */
  threads: number;
  fastPreviews: boolean;
  pauseInterval: number;
  maxPhraseDuration: number;
  speechLevel: number;
}

/** What the Mac app uses: WhisperKit's decoding defaults and the same live-phrase timing. */
export const DEFAULT_WHISPER_PARAMETERS: WhisperParameters = {
  beamSize: 1,
  temperature: 0,
  temperatureIncrement: 0.2,
  entropyThreshold: 2.4,
  logProbThreshold: -1,
  noSpeechThreshold: 0.6,
  suppressBlank: false,
  suppressNonSpeech: false,
  threads: 0,
  fastPreviews: true,
  pauseInterval: 0.6,
  maxPhraseDuration: 15,
  speechLevel: 0.006,
};

export interface Settings {
  /** "system" or the id of an input device. */
  audioSource: string;
  recordAudio: boolean;
  autosave: boolean;
  /** Empty means the default folder (Documents\Transcriber). */
  saveFolder: string;
  ytDLPPath: string;
  narratorMode: boolean;
  subtitleStyle: SubtitleStyle;
  frameRate: VideoFrameRate;
  appearance: Appearance;
  /** Whether the transcript folder is shown on the left of the main window. */
  showsSidebar: boolean;
  localeIdentifier: string;
  /** Languages used to transcribe, most recent first. */
  recentLocales: string[];
  whisperModel: WhisperModel;
  whisperCustomRepo: string;
  whisperCustomFile: string;
  /** Whether `whisperParameters` apply; otherwise the defaults do. */
  expertOptions: boolean;
  whisperParameters: WhisperParameters;
}

export const DEFAULT_SETTINGS: Settings = {
  audioSource: "system",
  recordAudio: false,
  autosave: true,
  saveFolder: "",
  ytDLPPath: "",
  narratorMode: false,
  subtitleStyle: "standard",
  frameRate: "30",
  appearance: "system",
  showsSidebar: false,
  localeIdentifier: "",
  recentLocales: [],
  whisperModel: "turboFast",
  whisperCustomRepo: DEFAULT_WHISPER_REPO,
  whisperCustomFile: "",
  expertOptions: false,
  whisperParameters: DEFAULT_WHISPER_PARAMETERS,
};

const STORAGE_KEYS: Record<keyof Settings, string> = {
  audioSource: "audioSource",
  recordAudio: "recordAudio",
  autosave: "autosave",
  saveFolder: "saveFolder",
  ytDLPPath: "ytDLPPath",
  narratorMode: "narratorMode",
  subtitleStyle: "subtitleStyle",
  frameRate: "frameRate",
  appearance: "appearance",
  showsSidebar: "showsSidebar",
  localeIdentifier: "localeIdentifier",
  recentLocales: "recentLocales",
  whisperModel: "whisperModel",
  whisperCustomRepo: "whisperCustomRepo",
  whisperCustomFile: "whisperCustomFile",
  expertOptions: "expertOptions",
  whisperParameters: "whisperParameters",
};

export function loadSettings(): Settings {
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(STORAGE_KEYS) as (keyof Settings)[]) {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS[key]);
      if (stored !== null) (settings as Record<string, unknown>)[key] = JSON.parse(stored);
    } catch {
      // Unreadable or missing storage: keep the default.
    }
  }
  // Parameters added in later versions get their defaults.
  settings.whisperParameters = { ...DEFAULT_WHISPER_PARAMETERS, ...settings.whisperParameters };
  return settings;
}

/** Stores one preference and tells the other window about it. */
export function storeSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  try {
    localStorage.setItem(STORAGE_KEYS[key], JSON.stringify(value));
  } catch {
    // Storage unavailable: the change still applies until the app quits.
  }
  void backend.broadcast("settings-changed", { key, value });
}

/** Applies the appearance to this window. */
export function applyAppearance(appearance: Appearance) {
  if (appearance === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = appearance;
}

/** What Settings shows about the main window's state; sent with `model-status`. */
export interface ModelStatus {
  isIdle: boolean;
  isWhisperModelDownloaded: boolean;
  hasWhisperModelSource: boolean;
  defaultSaveFolder: string;
  ytDLP: import("./backend").YTDLPTool | null;
  isCheckingYTDLP: boolean;
  ytDLPInstallCommand: string;
}
