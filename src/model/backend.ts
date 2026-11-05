// The Rust backend (src-tauri), and window/dialog/clipboard helpers. Opened in a plain browser (npm run dev
// without Tauri), it falls back to a simulation so the interface can be previewed and tested.

import type { WhisperParameters } from "./settings";
import type { AudioInfo } from "./subtitles";
import type { TimedWord } from "./subtitles";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface ModelSource {
  repo: string;
  file: string;
}

export interface InputDevice {
  uid: string;
  name: string;
}

/** An installed yt-dlp and its version (a release date such as "2026.08.19"). */
export interface YTDLPTool {
  path: string;
  version: string;
  isOutdated: boolean;
  updateCommand: string;
}

export interface Passage {
  start: number;
  text: string;
  words: TimedWord[];
}

/** A file or folder in the transcript folder. */
export interface LibraryEntry {
  name: string;
  path: string;
  isFolder: boolean;
  /** Milliseconds since 1970. */
  modified: number;
}

/** A window's x, y, width and height in physical pixels. */
export type WindowFrame = [number, number, number, number];

export interface FileDialogFilter {
  name: string;
  extensions: string[];
}

type Unlisten = () => void;

export interface Backend {
  whisperStatus(source: ModelSource): Promise<{ downloaded: boolean; loaded: boolean }>;
  modelsFolder(): Promise<string>;
  /** Emits `whisper-progress` (0...1, then null while loading). */
  prepareWhisper(source: ModelSource): Promise<void>;
  preloadWhisper(source: ModelSource): Promise<void>;
  listInputDevices(): Promise<InputDevice[]>;
  /** Emits `live-partial`, `live-final` and `live-level`. */
  startLive(options: { source: string; language: string | null; parameters: WhisperParameters; swissSpelling: boolean;
                       recordPath: string | null }): Promise<void>;
  /** Resolves once the last phrase was emitted; returns an error message if the audio couldn't be saved. */
  stopLive(): Promise<string | null>;
  /** Emits `file-progress` and `file-passage`. */
  transcribeFile(options: { path: string; language: string | null; parameters: WhisperParameters; swissSpelling: boolean;
                            wordTimestamps: boolean }): Promise<void>;
  audioInfo(path: string): Promise<AudioInfo>;
  cancelImport(): Promise<void>;
  resetCancel(): Promise<void>;
  defaultSaveFolder(): Promise<string>;
  writeText(path: string, contents: string): Promise<void>;
  uniquePath(folder: string, base: string, extension: string): Promise<string>;
  moveFile(from: string, to: string): Promise<void>;
  makeTempFolder(): Promise<string>;
  removeFolder(path: string): Promise<void>;
  /** The folders and files directly in `path`, folders first. Creates the folder. */
  listFolder(path: string): Promise<LibraryEntry[]>;
  /** Every folder inside `root`, at any depth, each right after its parent. */
  listSubfolders(root: string): Promise<string[]>;
  /** Creates `name` (or "name 2" and so on) in `parent`; returns its path. */
  createFolder(parent: string, name: string): Promise<string>;
  /** Renames a file or folder in place; returns its new path. */
  renameEntry(path: string, name: string): Promise<string>;
  /** Moves a file or folder into `folder`; returns its new path. */
  moveEntry(path: string, folder: string): Promise<string>;
  /** Renames a saved transcript and the files next to it with the same name; returns its new path. */
  renameTranscript(path: string, base: string): Promise<string>;
  /** Moves a file or folder to the Recycle Bin. */
  deleteEntry(path: string): Promise<void>;
  /**
   * Where the window goes to open or close the transcript folder pane: start and end frames (x, y, width, height
   * in physical pixels) to animate through with `setWindowFrame`, or null if the window keeps its size.
   * `background` ("#rrggbb") fills any strip the page hasn't painted yet while the window grows.
   */
  planSidebar(open: boolean, background: string): Promise<[WindowFrame, WindowFrame] | null>;
  setWindowFrame(frame: WindowFrame): Promise<void>;
  /** Raises the window's minimum width while the pane is open, so the transcript keeps its minimum. */
  setSidebarMinSize(open: boolean): Promise<void>;
  findYTDLP(customPath: string): Promise<YTDLPTool | null>;
  ytdlpInstallCommand(): Promise<string>;
  youtubeCaptions(tool: YTDLPTool, video: string, languageCode: string, folder: string):
    Promise<{ title: string; segments: { offset: number; text: string }[] } | null>;
  /** Emits `youtube-progress` (0...1). */
  youtubeDownloadAudio(tool: YTDLPTool, video: string, folder: string): Promise<{ title: string; file: string }>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<Unlisten>;
  /** Sends an event to every window (Settings talks to the main window this way). */
  broadcast(event: string, payload?: unknown): Promise<void>;

  saveDialog(options: { defaultPath: string; filters: FileDialogFilter[] }): Promise<string | null>;
  openFileDialog(options: { filters: FileDialogFilter[] }): Promise<string | null>;
  chooseFolder(defaultPath: string): Promise<string | null>;
  revealInExplorer(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  copyText(text: string): Promise<void>;
  readClipboard(): Promise<string>;
}

// MARK: - Tauri

async function makeTauriBackend(): Promise<Backend> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen, emit } = await import("@tauri-apps/api/event");
  const dialog = await import("@tauri-apps/plugin-dialog");
  const opener = await import("@tauri-apps/plugin-opener");
  const clipboard = await import("@tauri-apps/plugin-clipboard-manager");

  return {
    whisperStatus: (source) => invoke("whisper_status", { source }),
    modelsFolder: () => invoke("models_folder"),
    prepareWhisper: (source) => invoke("prepare_whisper", { source }),
    preloadWhisper: (source) => invoke("preload_whisper", { source }),
    listInputDevices: () => invoke("list_input_devices"),
    startLive: (options) => invoke("start_live", { options }),
    stopLive: () => invoke("stop_live"),
    transcribeFile: (options) => invoke("transcribe_file", { options }),
    audioInfo: async (path) => {
      const info = await invoke<{ duration: number; channels: number; sample_rate: number }>("audio_info", { path });
      return { path, duration: info.duration, channels: info.channels, sampleRate: info.sample_rate };
    },
    cancelImport: () => invoke("cancel_import"),
    resetCancel: () => invoke("reset_cancel"),
    defaultSaveFolder: () => invoke("default_save_folder"),
    writeText: (path, contents) => invoke("write_text", { path, contents }),
    uniquePath: (folder, base, extension) => invoke("unique_path", { folder, base, extension }),
    moveFile: (from, to) => invoke("move_file", { from, to }),
    makeTempFolder: () => invoke("make_temp_folder"),
    removeFolder: (path) => invoke("remove_folder", { path }),
    listFolder: (path) => invoke("list_folder", { path }),
    listSubfolders: (root) => invoke("list_subfolders", { root }),
    createFolder: (parent, name) => invoke("create_folder", { parent, name }),
    renameEntry: (path, name) => invoke("rename_entry", { path, name }),
    moveEntry: (path, folder) => invoke("move_entry", { path, folder }),
    renameTranscript: (path, base) => invoke("rename_transcript", { path, base }),
    deleteEntry: (path) => invoke("delete_entry", { path }),
    planSidebar: (open, background) => invoke("plan_sidebar", { open, background }),
    setWindowFrame: (frame) => invoke("set_window_frame", { frame }),
    setSidebarMinSize: (open) => invoke("set_sidebar_min_size", { open }),
    findYTDLP: (customPath) => invoke("find_ytdlp", { customPath }),
    ytdlpInstallCommand: () => invoke("ytdlp_install_command"),
    youtubeCaptions: (tool, video, languageCode, folder) => invoke("youtube_captions", { tool, video, languageCode, folder }),
    youtubeDownloadAudio: (tool, video, folder) => invoke("youtube_download_audio", { tool, video, folder }),
    listen: (event, handler) => listen(event, (e) => handler(e.payload as never)),
    broadcast: (event, payload) => emit(event, payload),

    saveDialog: async ({ defaultPath, filters }) => (await dialog.save({ defaultPath, filters })) ?? null,
    openFileDialog: async ({ filters }) => {
      const result = await dialog.open({ multiple: false, directory: false, filters });
      return typeof result === "string" ? result : null;
    },
    chooseFolder: async (defaultPath) => {
      const result = await dialog.open({ directory: true, defaultPath });
      return typeof result === "string" ? result : null;
    },
    revealInExplorer: (path) => opener.revealItemInDir(path),
    openPath: (path) => opener.openPath(path),
    copyText: (text) => clipboard.writeText(text),
    readClipboard: async () => (await clipboard.readText().catch(() => "")) ?? "",
  };
}

// MARK: - Browser preview

const SAMPLE = [
  "Grüezi mitenand, ich begrüsse Sie herzlich zur heutigen Sitzung.",
  "Wir beginnen mit dem ersten Traktandum, dem Budget für das nächste Jahr.",
  "Gibt es dazu Fragen?",
  "Dann kommen wir zur Abstimmung über den neuen Veloweg entlang des Sees.",
  "Der Bau soll im Frühling beginnen und rund zwei Millionen Franken kosten.",
];

function makePreviewBackend(): Backend {
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("transcriber-preview") : null;
  const local = new EventTarget();
  const emitLocal = (event: string, payload: unknown) => local.dispatchEvent(new CustomEvent(event, { detail: payload }));
  channel?.addEventListener("message", (e) => emitLocal(e.data.event, e.data.payload));
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const downloaded = new Set<string>(["ggerganov/whisper.cpp/ggml-large-v3-turbo-q5_0.bin"]);
  let cancelled = false;
  let live: { stop: () => void; done: Promise<void> } | null = null;
  // A pretend transcript folder: path → whether it's a folder.
  const root = "C:\\Users\\You\\Documents\\Transcriber";
  const files = new Map<string, boolean>([
    [`${root}\\Council`, true],
    [`${root}\\Council\\Gemeinderatssitzung vom 14. Oktober.txt`, false],
    [`${root}\\Transcript 2026-10-30 09.12.44.txt`, false],
    [`${root}\\Transcript 2026-10-30 09.12.44.wav`, false],
    [`${root}\\Interview.txt`, false],
  ]);
  const parentOf = (path: string) => path.replace(/\\[^\\]*$/, "");
  const nameOf = (path: string) => path.split("\\").pop()!;
  const relocate = (from: string, to: string) => {
    if ([...files.keys()].some((p) => p.toLowerCase() === to.toLowerCase() && p.toLowerCase() !== from.toLowerCase())) {
      throw `There's already an item named “${nameOf(to)}” there.`;
    }
    for (const [path, isFolder] of [...files]) {
      if (path === from || path.startsWith(from + "\\")) {
        files.delete(path);
        files.set(to + path.slice(from.length), isFolder);
      }
    }
    return to;
  };

  return {
    whisperStatus: async (source) => ({ downloaded: downloaded.has(`${source.repo}/${source.file}`), loaded: false }),
    modelsFolder: async () => "C:\\Users\\You\\AppData\\Roaming\\Transcriber\\Whisper",
    prepareWhisper: async (source) => {
      const key = `${source.repo}/${source.file}`;
      if (!downloaded.has(key)) {
        for (let p = 0; p <= 1; p += 0.05) {
          if (cancelled) throw "cancelled";
          emitLocal("whisper-progress", p);
          await sleep(120);
        }
        downloaded.add(key);
      }
      emitLocal("whisper-progress", null);
      await sleep(600);
    },
    preloadWhisper: async () => {},
    listInputDevices: async () => [
      { uid: "mic-1", name: "Microphone Array (Realtek Audio)" },
      { uid: "mic-2", name: "Headset (Jabra Evolve2 65)" },
    ],
    startLive: async () => {
      let stopped = false;
      const levels = setInterval(() => emitLocal("live-level", stopped ? 0 : Math.random() * 0.12), 50);
      const done = (async () => {
        for (const sentence of SAMPLE) {
          const words = sentence.split(" ");
          for (let i = 1; i <= words.length && !stopped; i++) {
            emitLocal("live-partial", words.slice(0, i).join(" "));
            await sleep(260);
          }
          if (stopped) break;
          await sleep(700);
          emitLocal("live-partial", "");
          emitLocal("live-final", sentence);
          await sleep(900);
        }
      })();
      live = { stop: () => { stopped = true; clearInterval(levels); }, done };
    },
    stopLive: async () => {
      live?.stop();
      await live?.done;
      live = null;
      emitLocal("live-partial", "");
      return null;
    },
    transcribeFile: async ({ wordTimestamps }) => {
      let offset = 0;
      for (const [index, sentence] of SAMPLE.entries()) {
        if (cancelled) throw "cancelled";
        await sleep(500);
        const words = sentence.split(" ").map((text, i) => ({ text, start: offset + i * 0.35, end: offset + i * 0.35 + 0.3 }));
        emitLocal("file-passage", { start: offset, text: sentence, words: wordTimestamps ? words : [] });
        emitLocal("file-progress", (index + 1) / SAMPLE.length);
        offset += words.length * 0.35 + 0.8;
      }
    },
    audioInfo: async (path) => ({ path, duration: 30, channels: 2, sampleRate: 48_000 }),
    cancelImport: async () => { cancelled = true; },
    resetCancel: async () => { cancelled = false; },
    defaultSaveFolder: async () => "C:\\Users\\You\\Documents\\Transcriber",
    writeText: async () => {},
    uniquePath: async (folder, base, extension) => `${folder}\\${base}.${extension}`,
    moveFile: async () => {},
    makeTempFolder: async () => "C:\\Temp\\Transcriber",
    removeFolder: async () => {},
    listFolder: async (path) => [...files]
      .filter(([p]) => parentOf(p) === path)
      .map(([p, isFolder]) => ({ name: nameOf(p), path: p, isFolder, modified: Date.now() }))
      .sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name)),
    listSubfolders: async (folder) => [...files].filter(([p, isFolder]) => isFolder && p.startsWith(folder + "\\")).map(([p]) => p).sort(),
    createFolder: async (parent, name) => {
      let path = `${parent}\\${name}`;
      for (let n = 2; files.has(path); n++) path = `${parent}\\${name} ${n}`;
      files.set(path, true);
      return path;
    },
    renameEntry: async (path, name) => relocate(path, `${parentOf(path)}\\${name.trim()}`),
    moveEntry: async (path, folder) => {
      if (folder === path || folder.startsWith(path + "\\")) throw "A folder can't be moved into itself.";
      return relocate(path, `${folder}\\${nameOf(path)}`);
    },
    renameTranscript: async (path, base) => relocate(path, `${parentOf(path)}\\${base}.txt`),
    deleteEntry: async (path) => {
      for (const p of [...files.keys()]) if (p === path || p.startsWith(path + "\\")) files.delete(p);
    },
    planSidebar: async () => null,
    setWindowFrame: async () => {},
    setSidebarMinSize: async () => {},
    findYTDLP: async () => {
      await sleep(400);
      return { path: "C:\\Users\\You\\AppData\\Local\\Microsoft\\WinGet\\Links\\yt-dlp.exe", version: "2026.09.30",
               isOutdated: false, updateCommand: "winget upgrade yt-dlp.yt-dlp" };
    },
    ytdlpInstallCommand: async () => "winget install yt-dlp.yt-dlp",
    youtubeCaptions: async () => {
      await sleep(800);
      return { title: "Gemeinderatssitzung vom 14. Oktober", segments: SAMPLE.map((text, i) => ({ offset: i * 9, text })) };
    },
    youtubeDownloadAudio: async () => ({ title: "Video", file: "C:\\Temp\\audio.m4a" }),
    listen: async (event, handler) => {
      const listener = (e: Event) => handler((e as CustomEvent).detail);
      local.addEventListener(event, listener);
      return () => local.removeEventListener(event, listener);
    },
    broadcast: async (event, payload) => {
      emitLocal(event, payload);
      channel?.postMessage({ event, payload });
    },
    saveDialog: async ({ defaultPath }) => defaultPath,
    openFileDialog: async () => "C:\\Users\\You\\Music\\Sitzung.m4a",
    chooseFolder: async (defaultPath) => defaultPath,
    revealInExplorer: async () => {},
    openPath: async () => {},
    copyText: (text) => navigator.clipboard?.writeText(text) ?? Promise.resolve(),
    readClipboard: async () => "",
  };
}

export const backend: Backend = isTauri ? await makeTauriBackend() : makePreviewBackend();
