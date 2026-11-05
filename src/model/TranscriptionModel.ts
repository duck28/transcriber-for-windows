// The app's state and behavior. A port of TranscriptionModel.swift; the Rust backend does the audio,
// speech recognition, yt-dlp and file work.

import { useSyncExternalStore } from "react";
import { backend, type InputDevice, type ModelSource, type Passage, type YTDLPTool } from "./backend";
import { appWindow } from "./appWindow";
import type { Library } from "./library";
import {
  availableLocales, displayName, preferredLocale, usesSwissSpelling, whisperLanguageCode,
} from "./languages";
import {
  applyAppearance, DEFAULT_WHISPER_PARAMETERS, DEFAULT_WHISPER_REPO, loadSettings, storeSetting, WHISPER_MODELS,
  type ModelStatus, type Settings,
} from "./settings";
import * as Subtitles from "./subtitles";
import type { SubtitleCue, SubtitleFormat, TimedWord } from "./subtitles";

export const SYSTEM_AUDIO_SOURCE_ID = "system";

export interface TranscriptSegment {
  id: number;
  /** Seconds since the live transcript started, or since the beginning of the imported media. */
  offset: number;
  text: string;
  /** When the segment ends; only known for subtitle cues. */
  end?: number;
}

export type TranscriptSource =
  | { kind: "live" }
  | { kind: "file"; path: string }
  | { kind: "youtube"; url: string }
  /** A voiceover turned into subtitles (narrator mode). */
  | { kind: "narration"; path: string };

/** A file or YouTube import in progress. */
export interface Activity {
  title: string;
  /** 0...1, or null while the duration is unknown. */
  progress: number | null;
}

export interface DialogButton {
  title: string;
  role?: "default" | "cancel";
}

/** An alert waiting for an answer (the equivalent of NSAlert). */
export interface Dialog {
  message: string;
  information: string;
  buttons: DialogButton[];
  answer: (index: number) => void;
}

export const AUDIO_FILE_EXTENSIONS = ["m4a", "mp3", "wav", "aac", "flac", "ogg", "oga", "caf", "aif", "aiff", "mp4", "m4v", "mov", "mkv", "webm"];

const pad = (n: number) => String(n).padStart(2, "0");
const lastPathComponent = (path: string) => path.split(/[\\/]/).pop() ?? path;
const deletingPathExtension = (name: string) => name.replace(/\.[^.\\/]*$/, "");
const pathExtension = (path: string) => /\.([^.\\/]*)$/.exec(path)?.[1] ?? "";
export const parentFolder = (path: string) => path.replace(/[\\/][^\\/]*$/, "");

/** Windows paths are case-insensitive. */
export const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Where `path` ends up after `from` was moved or renamed to `to` (unchanged if it isn't `from` or inside it). */
export const relocatedPath = (path: string, from: string, to: string) => {
  if (samePath(path, from)) return to;
  const prefix = from.toLowerCase() + "\\";
  return path.toLowerCase().startsWith(prefix) ? to + path.slice(from.length) : path;
};

const isCancellation = (error: unknown) => error === "cancelled" || String(error).includes("cancelled");

export class TranscriptionModel {
  // MARK: Transcript
  segments: TranscriptSegment[] = [];
  partialText = "";
  title = "";
  /** Set when the user named the transcript, so imports don't replace the name. */
  private titleChosen = false;
  source: TranscriptSource = { kind: "live" };
  /** Where the transcript is saved; auto-save keeps writing to this file. */
  savedPath: string | null = null;
  hasUnsavedChanges = false;
  private startDate = Date.now();
  private nextSegmentID = 1;

  // MARK: Live transcription
  isRunning = false;
  /** When the current live run started, for the elapsed-time display. */
  runStartedAt: number | null = null;
  level = 0;
  silentTooLong = false;
  inputDevices: InputDevice[] = [];
  private lastSoundAt = Date.now();
  private liveListeners: (() => void)[] = [];

  // MARK: Imports
  activity: Activity | null = null;
  showYouTubeImport = false;
  private importCancelled = false;

  errorMessage: string | null = null;
  dialog: Dialog | null = null;

  locales: string[] = availableLocales();
  settings: Settings = loadSettings();
  defaultSaveFolder = "";

  // MARK: Whisper
  /** Whether the selected Whisper model is on this PC. */
  isWhisperModelDownloaded = false;

  // MARK: yt-dlp
  /** The yt-dlp imports use; null if none was found (or while `isCheckingYTDLP` on first launch). */
  ytDLP: YTDLPTool | null = null;
  isCheckingYTDLP = false;
  ytDLPInstallCommand = "winget install yt-dlp.yt-dlp";
  private ytDLPCheck = 0;
  private ytDLPTimer: ReturnType<typeof setTimeout> | null = null;

  // MARK: Narrator mode
  /** Words of the current voiceover, kept so subtitles can be re-flowed when the style changes. */
  private narrationWords: TimedWord[] = [];
  subtitleCues: SubtitleCue[] = [];

  // MARK: Transcript folder (sidebar)
  /** Counts changes to the transcript folder made here, so the sidebar knows to list it again. */
  libraryVersion = 0;

  private lastAutosaveError: string | null = null;
  /** Auto-saves and changes to saved files run one after another, so a save never goes to a moved file. */
  private autosaveQueue: Promise<void> = Promise.resolve();
  /** Set once the user agreed to close, so the window doesn't ask twice. */
  private closeApproved = false;

  // MARK: - Observation

  private version = 0;
  private listeners = new Set<() => void>();
  private lastStatus = "";

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = () => this.version;

  private changed() {
    this.version++;
    this.listeners.forEach((listener) => listener());
    this.broadcastStatus();
  }

  constructor() {
    if (!this.locales.includes(this.settings.localeIdentifier)) {
      this.settings.localeIdentifier = preferredLocale(this.locales) ?? this.locales[0] ?? "en-US";
    }
    applyAppearance(this.settings.appearance);
  }

  /** Starts the background work; call once the window is up. */
  async launch() {
    this.defaultSaveFolder = await backend.defaultSaveFolder();
    void this.backend_ytdlpInstallCommand();
    this.refreshInputDevices();
    this.refreshWhisperModel();
    this.refreshYTDLP();
    void backend.listen<{ key: keyof Settings; value: never }>("settings-changed", ({ key, value }) => {
      if (JSON.stringify(this.settings[key]) !== JSON.stringify(value)) this.applySetting(key, value, false);
    });
    void backend.listen("settings-opened", () => {
      this.lastStatus = "";
      this.broadcastStatus();
    });
    void backend.listen<string>("model-action", (action) => {
      if (action === "downloadWhisperModel") this.downloadWhisperModel();
      if (action === "refreshYTDLP") this.refreshYTDLP();
    });
    // Pick up yt-dlp updates installed while the app was in the background.
    window.addEventListener("focus", () => this.refreshYTDLP());
    this.changed();
  }

  private async backend_ytdlpInstallCommand() {
    this.ytDLPInstallCommand = await backend.ytdlpInstallCommand();
  }

  /** What Settings shows; sent whenever it changes. */
  private broadcastStatus() {
    const status: ModelStatus = {
      isIdle: this.isIdle,
      isWhisperModelDownloaded: this.isWhisperModelDownloaded,
      hasWhisperModelSource: this.whisperModelSource !== null,
      defaultSaveFolder: this.defaultSaveFolder,
      ytDLP: this.ytDLP,
      isCheckingYTDLP: this.isCheckingYTDLP,
      ytDLPInstallCommand: this.ytDLPInstallCommand,
    };
    const json = JSON.stringify(status);
    if (json === this.lastStatus) return;
    this.lastStatus = json;
    void backend.broadcast("model-status", status);
  }

  // MARK: - Settings

  /** Changes a preference, stores it, and does what follows from it. */
  set<K extends keyof Settings>(key: K, value: Settings[K]) {
    this.applySetting(key, value, true);
  }

  private applySetting<K extends keyof Settings>(key: K, value: Settings[K], store: boolean) {
    this.settings = { ...this.settings, [key]: value };
    if (store) storeSetting(key, value);
    switch (key) {
      case "autosave": this.autosave(); break;
      case "ytDLPPath": this.refreshYTDLP(600); break;
      case "subtitleStyle": this.rebuildSubtitles(); break;
      case "appearance": applyAppearance(value as Settings["appearance"]); break;
      case "whisperModel": case "whisperCustomRepo": case "whisperCustomFile": this.refreshWhisperModel(); break;
    }
    this.changed();
  }

  get saveFolder() {
    return this.settings.saveFolder || this.defaultSaveFolder;
  }

  get isIdle() {
    return !this.isRunning && this.activity === null;
  }

  get canStartNewTranscript() {
    return this.isIdle && this.segments.length > 0;
  }

  get usesMicrophone() {
    return this.settings.audioSource !== SYSTEM_AUDIO_SOURCE_ID;
  }

  get selectedInputDevice() {
    return this.inputDevices.find((device) => device.uid === this.settings.audioSource) ?? null;
  }

  /** Whether the selected language can be transcribed right now. */
  get isSelectedLocaleInstalled() {
    return this.isWhisperModelDownloaded && whisperLanguageCode(this.settings.localeIdentifier) !== null;
  }

  get canExportSubtitles() {
    return this.subtitleCues.length > 0;
  }

  // MARK: - Languages

  displayName = (locale: string) => displayName(locale);

  get selectedLanguageName() {
    return displayName(this.settings.localeIdentifier);
  }

  /** Up to five recently used languages, newest first. */
  get recentLocales() {
    return this.settings.recentLocales.filter((id) => this.locales.includes(id));
  }

  /** Moves the selected language to the top of the recently used list. */
  private markSelectedLocaleUsed() {
    const id = this.settings.localeIdentifier;
    this.set("recentLocales", [id, ...this.settings.recentLocales.filter((other) => other !== id)].slice(0, 5));
  }

  private get recognitionOptions() {
    const id = this.settings.localeIdentifier;
    const parameters = this.settings.expertOptions ? this.settings.whisperParameters : DEFAULT_WHISPER_PARAMETERS;
    return { language: whisperLanguageCode(id), parameters, swissSpelling: usesSwissSpelling(id) };
  }

  // MARK: - Whisper

  /** Where the selected Whisper model comes from; null if a custom model isn't filled in. */
  get whisperModelSource(): ModelSource | null {
    const model = WHISPER_MODELS.find((m) => m.id === this.settings.whisperModel) ?? WHISPER_MODELS[0];
    if (model.id !== "custom") return { repo: DEFAULT_WHISPER_REPO, file: model.file };
    const repo = this.settings.whisperCustomRepo.trim();
    const file = this.settings.whisperCustomFile.trim();
    return repo && file ? { repo, file } : null;
  }

  get whisperModelTitle() {
    return (WHISPER_MODELS.find((m) => m.id === this.settings.whisperModel) ?? WHISPER_MODELS[0]).title;
  }

  refreshWhisperModel() {
    const source = this.whisperModelSource;
    if (!source) {
      this.isWhisperModelDownloaded = false;
      this.changed();
      return;
    }
    void backend.whisperStatus(source).then(({ downloaded }) => {
      if (JSON.stringify(source) !== JSON.stringify(this.whisperModelSource)) return;
      this.isWhisperModelDownloaded = downloaded;
      this.changed();
      // Load the model in the background so Start doesn't have to wait for it.
      if (downloaded) void backend.preloadWhisper(source).catch(() => {});
    });
  }

  /** Downloads the selected Whisper model from Hugging Face. Transcription itself never leaves this PC. */
  downloadWhisperModel = () => {
    if (!this.isIdle) return;
    this.runImport({ title: "Downloading the Whisper model…", progress: 0 }, () => this.prepareWhisper());
  };

  revealWhisperModels = async () => {
    await backend.openPath(await backend.modelsFolder());
  };

  /** Downloads and loads the Whisper model if needed, showing what happens in `activity`. */
  private async prepareWhisper() {
    const source = this.whisperModelSource;
    if (!source) throw "Choose a Whisper model in Settings › Speech Recognition.";
    const status = await backend.whisperStatus(source);
    if (status.loaded) return;
    const previous = this.activity;
    this.activity = status.downloaded
      ? { title: "Loading the Whisper model…", progress: null }
      : { title: "Downloading the Whisper model…", progress: 0 };
    this.changed();
    const unlisten = await backend.listen<number | null>("whisper-progress", (progress) => {
      if (!this.activity) return;
      if (progress !== null) {
        if (this.activity.progress !== null) this.activity = { ...this.activity, progress };
      } else {
        this.activity = { title: "Loading the Whisper model…", progress: null };
      }
      this.changed();
    });
    try {
      await backend.prepareWhisper(source);
    } finally {
      unlisten();
      this.activity = previous;
      this.refreshWhisperModel();
      this.changed();
    }
  }

  // MARK: - yt-dlp

  /** Looks for yt-dlp again (it takes a moment, since each copy is asked for its version). */
  refreshYTDLP = (delay = 0) => {
    if (this.ytDLPTimer) clearTimeout(this.ytDLPTimer);
    const check = ++this.ytDLPCheck;
    this.ytDLPTimer = setTimeout(async () => {
      this.isCheckingYTDLP = true;
      this.changed();
      const tool = await backend.findYTDLP(this.settings.ytDLPPath);
      if (check !== this.ytDLPCheck) return;
      this.ytDLP = tool;
      this.isCheckingYTDLP = false;
      this.changed();
    }, delay);
  };

  // MARK: - Audio sources

  refreshInputDevices = () => {
    void backend.listInputDevices().then((devices) => {
      this.inputDevices = devices;
      this.changed();
    });
  };

  // MARK: - Live transcription

  toggle = () => {
    if (this.isRunning) void this.stop();
    else void this.start();
  };

  async start() {
    if (!this.isIdle) return;
    this.errorMessage = null;
    this.changed();
    try {
      await this.prepareWhisper();
    } catch (error) {
      this.errorMessage = String(error);
      this.changed();
      return;
    }
    // Continue a live transcript after Stop; anything else starts a new one.
    if (this.source.kind !== "live" || this.segments.length === 0) {
      if (!(await this.beginTranscript(TranscriptionModel.liveTitle(), { kind: "live" }))) return;
    }

    this.liveListeners = await Promise.all([
      backend.listen<string>("live-partial", (text) => {
        this.partialText = text;
        this.changed();
      }),
      backend.listen<string>("live-final", (text) => {
        this.append([{ id: this.nextSegmentID++, offset: (Date.now() - this.startDate) / 1000, text }]);
      }),
      backend.listen<number>("live-level", (level) => this.updateLevel(level)),
    ]);
    try {
      const recordPath = this.settings.recordAudio
        ? await backend.uniquePath(this.saveFolder, TranscriptionModel.fileName(this.title), "wav")
        : null;
      await backend.startLive({ source: this.settings.audioSource, ...this.recognitionOptions, recordPath });
      this.lastSoundAt = Date.now();
      this.silentTooLong = false;
      this.isRunning = true;
      this.markSelectedLocaleUsed();
      this.runStartedAt = Date.now();
    } catch (error) {
      this.liveListeners.forEach((unlisten) => unlisten());
      this.liveListeners = [];
      this.errorMessage = String(error);
    }
    this.changed();
  }

  /** Resolves once the last segment has been added (and auto-saved). */
  async stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.runStartedAt = null;
    this.level = 0;
    this.silentTooLong = false;
    this.changed();
    const recorderError = await backend.stopLive().catch((error) => String(error));
    this.liveListeners.forEach((unlisten) => unlisten());
    this.liveListeners = [];
    this.partialText = "";
    if (recorderError) this.errorMessage = `Couldn't save the audio: ${recorderError}`;
    this.changed();
    await this.autosaveQueue;
  }

  private updateLevel(newLevel: number) {
    if (!this.isRunning) return;
    this.level = newLevel;
    const now = Date.now();
    if (newLevel > 0.0005) this.lastSoundAt = now;
    // A muted or disconnected source delivers silence instead of an error.
    this.silentTooLong = now - this.lastSoundAt > 10_000;
    this.changed();
  }

  private static liveTitle() {
    const d = new Date();
    return `Transcript ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  }

  // MARK: - Transcript

  /** Clears the transcript (asking first if it isn't saved). The saved file is kept. */
  newTranscript = async (): Promise<boolean> => {
    if (!this.isIdle || !(await this.confirmUnsavedChanges())) return false;
    this.segments = [];
    this.narrationWords = [];
    this.subtitleCues = [];
    this.partialText = "";
    this.title = "";
    this.titleChosen = false;
    this.source = { kind: "live" };
    this.savedPath = null;
    this.hasUnsavedChanges = false;
    this.lastAutosaveError = null;
    this.startDate = Date.now();
    this.changed();
    return true;
  };

  private async beginTranscript(title: string, source: TranscriptSource) {
    // A name given before anything was transcribed is for this transcript.
    const chosen = this.segments.length === 0 && this.titleChosen ? this.title : null;
    if (!(await this.newTranscript())) return false;
    this.title = chosen ?? title;
    this.titleChosen = chosen !== null;
    this.source = source;
    this.changed();
    return true;
  }

  /** Uses a title an import found (such as the video's), unless the user named the transcript. */
  private adoptTitle(title: string) {
    if (!this.titleChosen) this.title = title;
  }

  /** Names the transcript, renaming its saved file along with the subtitles and audio next to it. */
  renameTranscript = (newTitle: string) => {
    const title = newTitle.trim();
    if (!title || title === this.title) return;
    this.title = title;
    this.titleChosen = true;
    this.changed();
    void this.serialized(async () => {
      if (!this.savedPath) return;
      try {
        this.savedPath = await backend.renameTranscript(this.savedPath, TranscriptionModel.fileName(title));
        this.libraryVersion++;
      } catch (error) {
        this.errorMessage = `Couldn't rename the saved transcript: ${error}`;
      }
      this.changed();
    });
  };

  private append(newSegments: TranscriptSegment[]) {
    if (newSegments.length === 0) return;
    this.segments = [...this.segments, ...newSegments];
    this.hasUnsavedChanges = true;
    this.changed();
    this.autosave();
  }

  timestamp(segment: TranscriptSegment): string {
    if (this.source.kind === "live") {
      const d = new Date(this.startDate + segment.offset * 1000);
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
    const seconds = Math.floor(segment.offset);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    if (this.source.kind === "narration") {
      // Subtitles need finer timing: show tenths of a second.
      const tenths = Math.floor(segment.offset * 10) % 10;
      return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}.${tenths}` : `${pad(minutes)}:${pad(seconds % 60)}.${tenths}`;
    }
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${pad(minutes)}:${pad(seconds % 60)}`;
  }

  transcriptText(includingPartial = true): string {
    const lines: string[] = [];
    switch (this.source.kind) {
      case "live": break;
      case "file": case "narration": lines.push(this.title, `Source: ${lastPathComponent(this.source.path)}`, ""); break;
      case "youtube": lines.push(this.title, `Source: ${this.source.url}`, ""); break;
    }
    lines.push(...this.segments.map((segment) => `[${this.timestamp(segment)}] ${segment.text}`));
    if (includingPartial && this.partialText) lines.push(this.partialText);
    // Windows line endings, so Notepad and friends show the lines.
    return lines.join("\r\n");
  }

  get statusText() {
    const count = this.segments.length === 1 ? "1 segment" : `${this.segments.length} segments`;
    if (this.segments.length === 0) return "Transcribed on this PC";
    if (this.hasUnsavedChanges) return `${count} · Not saved`;
    if (this.savedPath) return `${count} · Saved to ${lastPathComponent(this.savedPath)}`;
    return count;
  }

  // MARK: - Saving

  private autosave() {
    this.autosaveQueue = this.autosaveQueue.then(() => this.writeAutosave());
  }

  private async writeAutosave() {
    if (!this.settings.autosave || this.segments.length === 0) return;
    try {
      const path = this.savedPath ?? (await this.uniquePath("txt"));
      await backend.writeText(path, this.transcriptText(false));
      if (this.subtitleCues.length > 0) {
        // Narrator mode: keep subtitles ready next to the transcript.
        await backend.writeText(deletingPathExtension(path) + ".srt", Subtitles.srt(this.subtitleCues).replace(/\n/g, "\r\n"));
      }
      if (this.savedPath === null) this.libraryVersion++;
      this.savedPath = path;
      this.hasUnsavedChanges = false;
      this.lastAutosaveError = null;
    } catch (error) {
      // Report each distinct problem once instead of after every segment.
      const message = `Couldn't save the transcript automatically: ${error}`;
      if (message !== this.lastAutosaveError) {
        this.lastAutosaveError = message;
        this.errorMessage = message;
      }
    }
    this.changed();
  }

  /** A file in the save folder named after the transcript that doesn't exist yet. */
  private uniquePath(extension: string) {
    return backend.uniquePath(this.saveFolder, TranscriptionModel.fileName(this.title), extension);
  }

  static fileName(title: string): string {
    const cleaned = title.split(/[/:\\<>"|?*\r\n]/).join("-").trim();
    return cleaned ? cleaned.slice(0, 120) : "Transcript";
  }

  copyToClipboard = () => void backend.copyText(this.transcriptText());

  /** Asks where to save. Auto-save keeps writing to the chosen file afterwards. */
  save = async (): Promise<boolean> => {
    const name = (this.savedPath ? deletingPathExtension(lastPathComponent(this.savedPath)) : TranscriptionModel.fileName(this.title)) + ".txt";
    const folder = this.savedPath ? parentFolder(this.savedPath) : this.saveFolder;
    const path = await backend.saveDialog({ defaultPath: `${folder}\\${name}`, filters: [{ name: "Text", extensions: ["txt"] }] });
    if (!path) return false;
    try {
      await backend.writeText(path, this.transcriptText(false));
      this.savedPath = path;
      this.hasUnsavedChanges = false;
      this.changed();
      return true;
    } catch (error) {
      this.errorMessage = `Could not save transcript: ${error}`;
      this.changed();
      return false;
    }
  };

  revealInExplorer = () => {
    if (this.savedPath) void backend.revealInExplorer(this.savedPath);
    else void backend.openPath(this.saveFolder);
  };

  chooseSaveFolder = async () => {
    const folder = await backend.chooseFolder(this.saveFolder);
    if (folder) this.set("saveFolder", folder);
  };

  // MARK: - Transcript folder (sidebar)

  /** Runs `work` once pending auto-saves are done; later auto-saves wait for it. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.autosaveQueue.then(work);
    this.autosaveQueue = result.then(() => {}, () => {});
    return result;
  }

  /** The transcript folder, for the sidebar. */
  get library(): Library {
    return {
      root: this.saveFolder,
      currentPath: this.savedPath,
      version: this.libraryVersion,
      createFolder: this.createLibraryFolder,
      rename: this.renameLibraryItem,
      move: this.moveLibraryItem,
      remove: this.deleteLibraryItem,
      chooseFolder: () => void this.chooseSaveFolder(),
    };
  }

  /** Asks, then moves a file or folder to the Recycle Bin. Returns whether it was deleted. */
  deleteLibraryItem = async (path: string, isFolder: boolean): Promise<boolean> => {
    const name = lastPathComponent(path);
    const containsTranscript = this.savedPath !== null
      && (samePath(this.savedPath, path) || this.savedPath.toLowerCase().startsWith(path.toLowerCase() + "\\"));
    const information = containsTranscript
      ? "This includes the open transcript. If you keep transcribing, it's saved again as a new file."
      : isFolder ? "The folder and everything in it can be restored from the Recycle Bin."
      : "You can restore it from the Recycle Bin.";
    if (!(await this.confirm(`Move “${name}” to the Recycle Bin?`, information, "Move to Recycle Bin"))) return false;
    return this.serialized(async () => {
      try {
        await backend.deleteEntry(path);
        if (containsTranscript) {
          this.savedPath = null;
          this.hasUnsavedChanges = this.segments.length > 0;
        }
        return true;
      } catch (error) {
        this.errorMessage = String(error);
        return false;
      } finally {
        this.libraryVersion++;
        this.changed();
      }
    });
  };

  /** Creates "New Folder" in `parent` and returns its path, or null if that failed. */
  createLibraryFolder = (parent: string) =>
    this.changeLibrary(() => backend.createFolder(parent, "New Folder"), null);

  /** Renames a file or folder in the transcript folder; returns its new path, or null if that failed. */
  renameLibraryItem = (path: string, name: string) =>
    this.changeLibrary(() => backend.renameEntry(path, name), path);

  /** Moves a file or folder into `folder`; returns its new path, or null if that failed. */
  moveLibraryItem = (path: string, folder: string) =>
    this.changeLibrary(() => backend.moveEntry(path, folder), path);

  /**
   * Changes the transcript folder between auto-saves. If the open transcript (or the folder it's in) was moved
   * or renamed, auto-save follows it; renaming the transcript's own file renames the transcript too.
   */
  private changeLibrary(change: () => Promise<string>, from: string | null): Promise<string | null> {
    return this.serialized(async () => {
      try {
        const to = await change();
        if (from !== null && this.savedPath) {
          const renamedOwnFile = samePath(this.savedPath, from) && samePath(parentFolder(from), parentFolder(to));
          this.savedPath = relocatedPath(this.savedPath, from, to);
          if (renamedOwnFile) {
            this.title = deletingPathExtension(lastPathComponent(to));
            this.titleChosen = true;
          }
        }
        return to;
      } catch (error) {
        this.errorMessage = String(error);
        return null;
      } finally {
        this.libraryVersion++;
        this.changed();
      }
    });
  }

  // MARK: - Imports

  chooseAudioFile = async () => {
    const path = await backend.openFileDialog({ filters: [{ name: "Audio and Video", extensions: AUDIO_FILE_EXTENSIONS }] });
    if (path) this.transcribeFile(path);
  };

  /** Transcribes a file, or in narrator mode turns it into subtitles. */
  transcribeFile = async (path: string) => {
    if (this.settings.narratorMode) {
      void this.transcribeVoiceover(path);
      return;
    }
    if (!this.isIdle || !(await this.beginTranscript(deletingPathExtension(lastPathComponent(path)), { kind: "file", path }))) return;
    this.markSelectedLocaleUsed();
    this.runImport({ title: `Transcribing “${lastPathComponent(path)}”…`, progress: 0 }, () => this.recognize(path));
  };

  importYouTube = async (video: string, useCaptions: boolean) => {
    if (!this.isIdle) return;
    const tool = this.ytDLP;
    if (!tool) {
      this.errorMessage = `Importing from YouTube needs yt-dlp. Install it with “${this.ytDLPInstallCommand}” in a terminal, or set its location in Settings.`;
      this.changed();
      return;
    }
    if (!(await this.beginTranscript("YouTube video", { kind: "youtube", url: video }))) return;
    this.markSelectedLocaleUsed();
    const languageCode = this.recognitionOptions.language ?? "en";

    this.runImport({ title: useCaptions ? "Getting captions from YouTube…" : "Getting the video from YouTube…", progress: null }, async () => {
      const folder = await backend.makeTempFolder();
      try {
        let captionsFailed = false;
        if (useCaptions) {
          try {
            const captions = await backend.youtubeCaptions(tool, video, languageCode, folder);
            if (captions) {
              this.adoptTitle(captions.title);
              this.append(captions.segments.map((s) => ({ id: this.nextSegmentID++, offset: s.offset, text: s.text })));
              if (!this.settings.recordAudio) return;
              try {
                const audio = await this.downloadAudio(tool, video, folder, "Downloading the audio…");
                await this.keepAudio(audio.file);
              } catch (error) {
                if (isCancellation(error)) throw error;
                this.errorMessage = `The transcript is saved, but the audio couldn't be saved: ${error}`;
              }
              return;
            }
          } catch (error) {
            if (isCancellation(error)) throw error;
            // Rate limits and the like often only affect captions; the audio may still work.
            captionsFailed = true;
          }
        }
        const status = !useCaptions ? "Downloading the audio…"
          : captionsFailed ? "Couldn't get captions. Downloading the audio…"
          : "No captions in this language. Downloading the audio…";
        const audio = await this.downloadAudio(tool, video, folder, status);
        this.adoptTitle(audio.title);
        this.activity = { title: `Transcribing “${audio.title}”…`, progress: 0 };
        this.changed();
        await this.recognize(audio.file);
        if (this.settings.recordAudio) await this.keepAudio(audio.file);
      } finally {
        void backend.removeFolder(folder);
      }
    });
  };

  private async downloadAudio(tool: YTDLPTool, video: string, folder: string, status: string) {
    this.activity = { title: status, progress: 0 };
    this.changed();
    const unlisten = await backend.listen<number>("youtube-progress", (progress) => {
      if (this.activity?.progress !== null && this.activity) {
        this.activity = { ...this.activity, progress };
        this.changed();
      }
    });
    try {
      return await backend.youtubeDownloadAudio(tool, video, folder);
    } finally {
      unlisten();
    }
  }

  /** Moves a downloaded audio file into the save folder, next to the transcript. */
  private async keepAudio(file: string) {
    try {
      await backend.moveFile(file, await this.uniquePath(pathExtension(file)));
    } catch (error) {
      throw `Couldn't save the audio: ${error}`;
    }
  }

  cancelImport = () => {
    this.importCancelled = true;
    void backend.cancelImport();
  };

  private async recognize(path: string, onPassage?: (passage: Passage) => void) {
    await this.prepareWhisper();
    const handle = onPassage ?? ((passage: Passage) =>
      this.append([{ id: this.nextSegmentID++, offset: passage.start, text: passage.text }]));
    const unlisteners = await Promise.all([
      backend.listen<number | null>("file-progress", (progress) => {
        if (this.activity && progress !== null) {
          this.activity = { ...this.activity, progress };
          this.changed();
        }
      }),
      backend.listen<Passage>("file-passage", handle),
    ]);
    try {
      await backend.transcribeFile({ path, ...this.recognitionOptions, wordTimestamps: onPassage !== undefined });
    } finally {
      unlisteners.forEach((unlisten) => unlisten());
    }
  }

  // MARK: - Narrator mode (subtitles)

  private async transcribeVoiceover(path: string) {
    if (!this.isIdle || !(await this.beginTranscript(deletingPathExtension(lastPathComponent(path)), { kind: "narration", path }))) return;
    this.markSelectedLocaleUsed();
    this.runImport({ title: `Creating subtitles for “${lastPathComponent(path)}”…`, progress: 0 }, () =>
      this.recognize(path, (passage) => {
        this.narrationWords = [...this.narrationWords, ...passage.words];
        this.rebuildSubtitles();
      }));
  }

  /** Recomputes the subtitles from the voiceover's words and shows them as the transcript. */
  private rebuildSubtitles() {
    if (this.source.kind !== "narration" || this.narrationWords.length === 0) return;
    this.subtitleCues = Subtitles.buildCues(this.narrationWords, this.settings.subtitleStyle);
    this.segments = this.subtitleCues.map((cue, index) => ({ id: index + 1, offset: cue.start, text: Subtitles.cueText(cue), end: cue.end }));
    this.hasUnsavedChanges = true;
    this.changed();
    this.autosave();
  }

  exportSubtitles = async (format: SubtitleFormat) => {
    if (!this.canExportSubtitles) return;
    const contents = await this.subtitleFile(format);
    if (!contents) return;
    const info = Subtitles.SUBTITLE_FORMATS.find((f) => f.id === format)!;
    const folder = this.savedPath ? parentFolder(this.savedPath) : this.saveFolder;
    const path = await backend.saveDialog({
      defaultPath: `${folder}\\${TranscriptionModel.fileName(this.title)}.${info.fileExtension}`,
      filters: [{ name: info.filterName, extensions: [info.fileExtension] }],
    });
    if (!path) return;
    try {
      await backend.writeText(path, format === "finalCutPro" ? contents : contents.replace(/\n/g, "\r\n"));
    } catch (error) {
      this.errorMessage = `Couldn't export the subtitles: ${error}`;
      this.changed();
    }
  };

  private async subtitleFile(format: SubtitleFormat): Promise<string | null> {
    switch (format) {
      case "srt": return Subtitles.srt(this.subtitleCues);
      case "webVTT": return Subtitles.webVTT(this.subtitleCues);
      case "finalCutPro": {
        if (this.source.kind !== "narration") return null;
        const path = this.source.path;
        const audio = await backend.audioInfo(path).catch(() => ({
          path, duration: this.subtitleCues[this.subtitleCues.length - 1]?.end ?? 0, channels: 2, sampleRate: 48_000,
        }));
        return Subtitles.finalCutPro(this.subtitleCues, audio, `${this.title} – Subtitles`,
          this.recognitionOptions.language ?? "en", this.settings.frameRate);
      }
    }
  }

  private runImport(activity: Activity, work: () => Promise<void>) {
    this.errorMessage = null;
    this.activity = activity;
    this.importCancelled = false;
    this.changed();
    void (async () => {
      await backend.resetCancel();
      try {
        await work();
      } catch (error) {
        if (!isCancellation(error) && !this.importCancelled) this.errorMessage = String(error);
      }
      this.activity = null;
      this.changed();
    })();
  }

  // MARK: - Closing

  get needsConfirmationBeforeClosing() {
    return !this.closeApproved && (!this.isIdle || this.hasUnsavedChanges);
  }

  /** Called before the window closes. Asks first if needed; resolves to whether to close. */
  shouldClose = async (): Promise<boolean> => {
    if (!this.needsConfirmationBeforeClosing) return true;
    const approved = await this.requestClose();
    if (approved) this.closeApproved = true;
    return approved;
  };

  /** Stops running work and offers to save, asking at each step. */
  private async requestClose(): Promise<boolean> {
    if (this.activity) {
      if (!(await this.confirm("An import is still in progress.", "Closing cancels it. The text transcribed so far is kept.",
        "Cancel Import and Close"))) return false;
      this.cancelImport();
    }
    if (this.isRunning) {
      if (!(await this.confirm("Transcription is still running.",
        this.settings.autosave ? "Transcriber stops listening and saves the transcript before closing."
                               : "Transcriber stops listening before closing.",
        "Stop and Close"))) return false;
      await this.stop();
    }
    return this.confirmUnsavedChanges();
  }

  /** Returns false if the user wants to keep the current transcript. */
  private async confirmUnsavedChanges(): Promise<boolean> {
    await this.autosaveQueue;
    if (!this.hasUnsavedChanges || this.segments.length === 0) return true;
    const answer = await this.ask("Do you want to save the transcript?",
      this.settings.autosave ? "It couldn't be saved automatically. If you don't save it, it will be lost."
                             : "Auto-save is off. If you don't save the transcript, it will be lost.",
      [{ title: "Save…", role: "default" }, { title: "Cancel", role: "cancel" }, { title: "Don't Save" }]);
    if (answer === 0) return this.save();
    if (answer === 2) {
      this.hasUnsavedChanges = false;
      this.changed();
      return true;
    }
    return false;
  }

  private async confirm(message: string, information: string, proceed: string) {
    return (await this.ask(message, information, [{ title: proceed, role: "default" }, { title: "Cancel", role: "cancel" }])) === 0;
  }

  /** Shows an alert; resolves to the index of the chosen button. */
  private ask(message: string, information: string, buttons: DialogButton[]): Promise<number> {
    return new Promise((resolve) => {
      this.dialog = {
        message, information, buttons,
        answer: (index) => {
          this.dialog = null;
          this.changed();
          resolve(index);
        },
      };
      this.changed();
    });
  }

  dismissError = () => {
    this.errorMessage = null;
    this.changed();
  };

  setShowYouTubeImport = (show: boolean) => {
    this.showYouTubeImport = show;
    this.changed();
  };

  openSettings = () => void appWindow.openSettings();
}

export const model = new TranscriptionModel();

/** Re-renders the component whenever the model changes. */
export function useModel(): TranscriptionModel {
  useSyncExternalStore(model.subscribe, model.getVersion);
  return model;
}
