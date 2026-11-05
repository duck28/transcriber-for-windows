import {
  ArrowDown, AudioLines, AudioWaveform, Captions, ChevronDown, CircleArrowDown, Copy, FileDown, Folder, Globe,
  ListChecks, Mic, MicOff, MicVocal, PanelLeft, Plus, Settings, Share, SquareArrowDown, SquarePen, SquarePlay,
  TriangleAlert, Volume2, VolumeX,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { backend, isTauri } from "../model/backend";
import { whisperLanguageCode } from "../model/languages";
import { SUBTITLE_FORMATS } from "../model/subtitles";
import { SYSTEM_AUDIO_SOURCE_ID, useModel, type TranscriptionModel } from "../model/TranscriptionModel";
import { item, MenuButton, section, separator, type MenuEntry } from "./Menu";
import { ActivityCard, AlertView, NoticeCard, RecordButton, SegmentRow, Waveform } from "./Pieces";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";
import { YouTubeImportSheet } from "./YouTubeImportSheet";

export function ContentView() {
  const model = useModel();
  const [isDropTargeted, setDropTargeted] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const windowElement = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  /** Whether new text scrolls into view: only while the transcript is scrolled to the end. */
  const followsNewText = useRef(true);
  const lastScrollTop = useRef(0);
  const [isScrolledBack, setScrolledBack] = useState(false);
  const showsEmptyState = model.segments.length === 0 && model.partialText === "";
  const { showsSidebar } = model.settings;

  useKeyboardShortcuts(model);
  useFileDrop(model, setDropTargeted);

  const pane = useSidebarPane(showsSidebar, windowElement, content);

  // Keep the newest text in view, unless the user scrolled back to read.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (model.segments.length === 0) {
      followsNewText.current = true;
      setScrolledBack(false);
    }
    if (element && followsNewText.current) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [model.segments.length, model.partialText]);

  const onScroll = () => {
    const element = scroller.current!;
    const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 4;
    // Scrolling into view only ever moves down, so moving up is the user scrolling back.
    // (Removing the preview line can pull the view up too, but then it's still at the end.)
    if (atEnd) followsNewText.current = true;
    else if (element.scrollTop < lastScrollTop.current - 1) followsNewText.current = false;
    lastScrollTop.current = element.scrollTop;
    setScrolledBack(!followsNewText.current);
  };

  const jumpToLatest = () => {
    followsNewText.current = true;
    setScrolledBack(false);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  };

  return (
    <div ref={windowElement} className={`window with-panes pane-${pane.phase}`}>
      {pane.phase !== "closed" && <Sidebar library={model.library} onClose={() => model.set("showsSidebar", false)} />}

      <div ref={content} className="content"
           style={pane.contentWidth !== null ? { flex: "none", width: pane.contentWidth } : undefined}>
        <TitleBar title={model.title || "Transcriber"} subtitle={model.statusText}
                  leading={<SidebarToggle model={model} />}
                  rename={{
                    value: model.title,
                    placeholder: model.segments.length === 0 ? "Name the next transcript" : "Transcript name",
                    onRename: model.renameTranscript,
                  }}>
          <Toolbar model={model} />
        </TitleBar>

        <div ref={scroller} className="transcript" onScroll={onScroll}>
          <div className="rows">
            {model.segments.map((segment) => (
              <SegmentRow key={segment.id} timestamp={model.timestamp(segment)} text={segment.text} />
            ))}
            {model.partialText !== "" && <SegmentRow timestamp={null} text={model.partialText} />}
          </div>
        </div>
        {showsEmptyState && <EmptyState model={model} />}
        {isScrolledBack && (model.isRunning || model.activity) && (
          <button className="jump-to-latest glass-button small" onClick={jumpToLatest}>
            <ArrowDown size={12} />Latest
          </button>
        )}

        <Notices model={model} />
        <ControlBar model={model} />
      </div>

      {isDropTargeted && (
        <div className="drop-highlight">
          <span className="drop-label glass"><FileDown size={18} />Drop to Transcribe</span>
        </div>
      )}
      {model.showYouTubeImport && <YouTubeImportSheet />}
      {model.dialog && <AlertView dialog={model.dialog} />}
    </div>
  );
}

// MARK: - Sidebar

/** The pane's width (`SIDEBAR_WIDTH` in lib.rs) and how long it takes to open or close (`--pane-duration`). */
const PANE_WIDTH = 280;
const PANE_ANIMATION_MS = 240;
const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

interface Pane {
  phase: "closed" | "opening" | "open" | "closing";
  /** While the window grows or shrinks, the transcript keeps this width and slides over. */
  contentWidth: number | null;
}

/**
 * Opens and closes the transcript folder pane like a book: the window grows on the right by the pane's width while
 * the pane unfolds on the left, so the transcript keeps its size. A maximized window can't grow; there the pane
 * takes its room from the transcript. Each frame sets the pane's width and the window's frame together, so the
 * page and the window edge stay in step.
 */
function useSidebarPane(open: boolean, windowElement: RefObject<HTMLDivElement | null>,
                        content: RefObject<HTMLDivElement | null>): Pane {
  const [pane, setPane] = useState<Pane>({ phase: "closed", contentWidth: null });
  const target = useRef(false);
  const queue = useRef(Promise.resolve());

  useEffect(() => {
    if (open === target.current) return;
    target.current = open;
    queue.current = queue.current.then(async () => {
      const element = windowElement.current!;
      const background = getComputedStyle(document.documentElement).getPropertyValue("--window").trim();
      if (!open) await backend.setSidebarMinSize(false).catch(() => {});
      const frames = await backend.planSidebar(open, background).catch(() => null);
      element.style.setProperty("--pane-width", `${open ? 0 : PANE_WIDTH}px`);
      setPane({ phase: open ? "opening" : "closing", contentWidth: frames ? content.current?.clientWidth ?? null : null });
      await new Promise((resolve) => requestAnimationFrame(resolve));

      const duration = prefersReducedMotion() ? 1 : PANE_ANIMATION_MS;
      await new Promise<void>((resolve) => {
        const start = performance.now();
        const step = (now: number) => {
          const t = Math.min(1, (now - start) / duration);
          const progress = easeOutCubic(t);
          element.style.setProperty("--pane-width", `${PANE_WIDTH * (open ? progress : 1 - progress)}px`);
          if (frames) {
            const [from, to] = frames;
            void backend.setWindowFrame(from.map((value, i) => Math.round(value + (to[i] - value) * progress)) as typeof from);
          }
          if (t < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });

      if (open) await backend.setSidebarMinSize(true).catch(() => {});
      // The width stays at its end value: clearing it would show the full-width pane for the frame before React
      // removes a closed one.
      setPane({ phase: open ? "open" : "closed", contentWidth: null });
    });
  }, [open, windowElement, content]);

  return pane;
}

// MARK: - Toolbar

function SidebarToggle({ model }: { model: TranscriptionModel }) {
  const { showsSidebar } = model.settings;
  return (
    <div className="toolbar-group glass">
      <button className={`toolbar-button${showsSidebar ? " on" : ""}`} aria-pressed={showsSidebar} aria-label="Transcripts"
              title={showsSidebar ? "Hide the transcript folder (Ctrl+Shift+L)" : "Show the transcript folder (Ctrl+Shift+L)"}
              onClick={() => model.set("showsSidebar", !showsSidebar)}>
        <PanelLeft size={15} />
      </button>
    </div>
  );
}

function Toolbar({ model }: { model: TranscriptionModel }) {
  const { narratorMode } = model.settings;
  return (
    <>
      <div className="toolbar-group glass">
        <button className={`toolbar-button${narratorMode ? " on" : ""}`} disabled={!model.isIdle}
                aria-pressed={narratorMode} aria-label="Narrator Mode"
                title={narratorMode ? "Narrator mode is on: imported voiceovers become timed subtitles"
                                    : "Turn on narrator mode to turn voiceovers into timed subtitles (Ctrl+Shift+N)"}
                onClick={() => model.set("narratorMode", !narratorMode)}>
          <Captions size={16} />
        </button>
        {model.canExportSubtitles && (
          <MenuButton className="toolbar-button with-chevron" ariaLabel="Export Subtitles"
                      title="Export the subtitles for DaVinci Resolve, Premiere Pro or Final Cut Pro"
                      label={<><Share size={15} /><ChevronDown size={10} /></>}
                      entries={() => SUBTITLE_FORMATS.map((f) => item(f.menuTitle, () => void model.exportSubtitles(f.id)))} />
        )}
      </div>
      <div className="toolbar-group glass">
        <MenuButton className="toolbar-button with-chevron" ariaLabel="Import"
                    disabled={!model.isIdle || !model.isSelectedLocaleInstalled}
                    title="Transcribe a recording, such as a voice memo, or a YouTube video"
                    label={<><Plus size={17} /><ChevronDown size={10} /></>}
                    entries={() => [
                      item(narratorMode ? "Voiceover…" : "Audio File…", () => void model.chooseAudioFile(), { icon: <AudioLines size={14} /> }),
                      item("YouTube Video…", () => model.setShowYouTubeImport(true), { icon: <SquarePlay size={14} /> }),
                    ]} />
        <button className="toolbar-button" disabled={!model.canStartNewTranscript} aria-label="New Transcript"
                title="Start a new transcript (Ctrl+N)" onClick={() => void model.newTranscript()}>
          <SquarePen size={15} />
        </button>
      </div>
      <div className="toolbar-group glass">
        <button className="toolbar-button" disabled={model.segments.length === 0} aria-label="Copy"
                title="Copy the transcript" onClick={model.copyToClipboard}>
          <Copy size={15} />
        </button>
        <button className="toolbar-button" disabled={model.segments.length === 0} aria-label="Save As…"
                title="Save the transcript to a file of your choice (Ctrl+Shift+S)" onClick={() => void model.save()}>
          <SquareArrowDown size={16} />
        </button>
        <button className="toolbar-button" aria-label="Show in Explorer" title="Show the saved transcript in File Explorer"
                onClick={model.revealInExplorer}>
          <Folder size={15} />
        </button>
      </div>
      <div className="toolbar-group glass">
        <button className="toolbar-button" aria-label="Settings" title="Settings (Ctrl+,)" onClick={model.openSettings}>
          <Settings size={15} />
        </button>
      </div>
    </>
  );
}

// MARK: - Empty state

function EmptyState({ model }: { model: TranscriptionModel }) {
  const unavailable = (icon: React.ReactNode, title: string, description: string, actions?: React.ReactNode, animated = false) => (
    <div className="unavailable">
      <span className={`unavailable-icon${animated ? " animated" : ""}`}>{icon}</span>
      <h2>{title}</h2>
      <p>{description}</p>
      {actions && <div className="unavailable-actions">{actions}</div>}
    </div>
  );
  if (model.isRunning) {
    return unavailable(<AudioLines size={40} strokeWidth={1.6} />, "Listening…",
      model.usesMicrophone ? "Start speaking. Text appears after each pause." : "Play something on your PC. Text appears after each pause.",
      undefined, true);
  }
  if (model.activity) {
    return unavailable(<ListChecks size={40} strokeWidth={1.6} />, "Working on It", model.activity.title);
  }
  if (model.settings.narratorMode) {
    return unavailable(<Captions size={40} strokeWidth={1.6} />, "Narrator Mode",
      "Drop a voiceover here to turn it into subtitles timed to every word. Export them as SRT for DaVinci Resolve and Premiere Pro, or as a Final Cut Pro project with the voiceover and captions already in sync.",
      <button className="glass-button prominent" disabled={!model.isSelectedLocaleInstalled} onClick={() => void model.chooseAudioFile()}>
        <AudioLines size={14} />Choose Voiceover…
      </button>);
  }
  return unavailable(<MicVocal size={40} strokeWidth={1.6} />, "Ready to Transcribe",
    model.usesMicrophone
      ? "Press the record button to transcribe what your microphone hears, or transcribe a recording or a YouTube video. You can also drop an audio file here."
      : "Press the record button to transcribe whatever your PC is playing, or transcribe a recording or a YouTube video. You can also drop an audio file here.",
    <>
      <button className="glass-button" disabled={!model.isSelectedLocaleInstalled} onClick={() => void model.chooseAudioFile()}>
        <AudioLines size={14} />Transcribe a File…
      </button>
      <button className="glass-button" disabled={!model.isSelectedLocaleInstalled} onClick={() => model.setShowYouTubeImport(true)}>
        <SquarePlay size={14} />YouTube Video…
      </button>
    </>);
}

// MARK: - Notices

function Notices({ model }: { model: TranscriptionModel }) {
  let notice: React.ReactNode = null;
  if (model.errorMessage) {
    notice = <NoticeCard text={model.errorMessage} icon={<TriangleAlert size={18} fill="currentColor" stroke="var(--window)" />}
                         tint="var(--red)" onClose={model.dismissError} />;
  } else if (!model.isSelectedLocaleInstalled) {
    notice = <WhisperNotice model={model} />;
  } else if (model.silentTooLong) {
    const device = model.selectedInputDevice;
    const hint = device
      ? `No sound from “${device.name}”. Check that it's the right microphone, or allow microphone access under Windows Settings › Privacy & security › Microphone.`
      : "No audio received. Play something on your PC, and check that sound isn't muted.";
    notice = <NoticeCard text={hint} icon={<VolumeX size={18} />} tint="var(--orange)" />;
  }
  if (!model.activity && !notice) return null;
  return (
    <div className="notices">
      {model.activity && <ActivityCard activity={model.activity} onCancel={model.cancelImport} />}
      {notice}
    </div>
  );
}

function WhisperNotice({ model }: { model: TranscriptionModel }) {
  if (!model.whisperModelSource) {
    return <NoticeCard text="Enter the custom Whisper model in Settings › Speech Recognition." icon={<Settings size={18} />}
                       tint="var(--blue)" action={{ title: "Open Settings", perform: model.openSettings }} />;
  }
  if (!model.isWhisperModelDownloaded) {
    return <NoticeCard
      text={`Whisper needs its speech model on your PC: ${model.whisperModelTitle}. It's downloaded once from Hugging Face; after that, transcription runs entirely on this PC, even offline.`}
      icon={<CircleArrowDown size={18} />} tint="var(--blue)"
      action={model.activity === null ? { title: "Download Model", perform: model.downloadWhisperModel } : null} />;
  }
  return <NoticeCard text="Whisper doesn't support this language. Choose another one." icon={<Globe size={18} />} tint="var(--orange)" />;
}

// MARK: - Control bar

function ControlBar({ model }: { model: TranscriptionModel }) {
  return (
    <div className="control-bar">
      <InputControls model={model} />
      <RecordButton isRunning={model.isRunning} onClick={model.toggle}
                    disabled={!model.isRunning && (!model.isIdle || !model.isSelectedLocaleInstalled)} />
      <MeterControls model={model} />
    </div>
  );
}

function InputControls({ model }: { model: TranscriptionModel }) {
  const sourceName = !model.usesMicrophone ? "System Audio" : model.selectedInputDevice?.name ?? "Disconnected Microphone";
  const sourceEntries = (): MenuEntry[] => {
    const choose = (id: string) => () => model.set("audioSource", id);
    const entries: MenuEntry[] = [
      item("System Audio", choose(SYSTEM_AUDIO_SOURCE_ID), { checked: !model.usesMicrophone, icon: <Volume2 size={14} /> }),
    ];
    if (model.inputDevices.length > 0) entries.push(separator);
    for (const device of model.inputDevices) {
      entries.push(item(device.name, choose(device.uid), { checked: model.settings.audioSource === device.uid, icon: <Mic size={14} /> }));
    }
    if (model.usesMicrophone && !model.selectedInputDevice) {
      entries.push(item("Disconnected Microphone", () => {}, { checked: true, icon: <MicOff size={14} /> }));
    }
    return entries;
  };

  return (
    <div className="capsule inputs glass">
      <MenuButton className="menu-label" disabled={model.isRunning} onOpen={model.refreshInputDevices}
                  title="What to transcribe: everything your PC plays, or a microphone"
                  label={<>{model.usesMicrophone ? <Mic size={14} fill="currentColor" /> : <Volume2 size={14} fill="currentColor" />}
                    {sourceName}<ChevronDown size={11} className="chevron" /></>}
                  entries={sourceEntries} />
      <span className="inputs-divider" />
      <MenuButton className="menu-label" disabled={!model.isIdle || model.locales.length === 0}
                  title="Language to transcribe"
                  label={<><Globe size={14} />{model.selectedLanguageName}<ChevronDown size={11} className="chevron" /></>}
                  entries={() => languageEntries(model)} />
    </div>
  );
}

/** Recently used languages first, then every language Whisper handles (one model covers them all). */
function languageEntries(model: TranscriptionModel): MenuEntry[] {
  const languageItem = (id: string) =>
    item(model.displayName(id), () => model.set("localeIdentifier", id), { checked: model.settings.localeIdentifier === id });
  const entries: MenuEntry[] = [];
  if (model.recentLocales.length > 0) {
    entries.push(section("Recently Used"), ...model.recentLocales.map(languageItem));
  }
  entries.push(section("Whisper"), ...model.locales.filter((id) => whisperLanguageCode(id) !== null).map(languageItem));
  return entries;
}

function MeterControls({ model }: { model: TranscriptionModel }) {
  const elapsed = useElapsed(model.runStartedAt);
  const { recordAudio } = model.settings;
  return (
    <div className="capsule meter glass">
      <Waveform level={model.level} isActive={model.isRunning} />
      <span className={`timer${model.runStartedAt ? "" : " secondary"}`}>{elapsed}</span>
      <button className={`record-audio${recordAudio ? " on" : ""}`} disabled={model.isRunning}
              aria-pressed={recordAudio} aria-label="Save Audio"
              title={recordAudio ? "Saving audio next to the transcript. Click to turn off." : "Also save the audio next to the transcript"}
              onClick={() => model.set("recordAudio", !recordAudio)}>
        <AudioWaveform size={12} strokeWidth={2.5} />
      </button>
    </div>
  );
}

/** "0:00", counting up from `start`. */
function useElapsed(start: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (start === null) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [start]);
  if (start === null) return "0:00";
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  const s = String(seconds % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// MARK: - Keyboard and drop

/** The Mac app's menu commands, with Ctrl in place of ⌘. */
function useKeyboardShortcuts(model: TranscriptionModel) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || model.dialog || model.showYouTubeImport) return;
      const key = e.key.toLowerCase();
      const run = (action: () => void) => {
        e.preventDefault();
        action();
      };
      if (key === "r" && !e.shiftKey) {
        if (model.isRunning || (model.isIdle && model.isSelectedLocaleInstalled)) run(model.toggle);
      } else if (key === "n" && !e.shiftKey) {
        if (model.canStartNewTranscript) run(() => void model.newTranscript());
      } else if (key === "n" && e.shiftKey) {
        if (model.isIdle) run(() => model.set("narratorMode", !model.settings.narratorMode));
      } else if (key === "o" && !e.shiftKey) {
        if (model.isIdle && model.isSelectedLocaleInstalled) run(() => void model.chooseAudioFile());
      } else if (key === "y" && e.shiftKey) {
        if (model.isIdle && model.isSelectedLocaleInstalled) run(() => model.setShowYouTubeImport(true));
      } else if (key === "s" && e.shiftKey) {
        if (model.segments.length > 0) run(() => void model.save());
      } else if (key === "l" && e.shiftKey) {
        run(() => model.set("showsSidebar", !model.settings.showsSidebar));
      } else if (key === "," && !e.shiftKey) {
        run(model.openSettings);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [model]);
}

/** Dropping an audio or video file on the window transcribes it. */
function useFileDrop(model: TranscriptionModel, setTargeted: (targeted: boolean) => void) {
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setTargeted(model.isIdle);
        } else if (payload.type === "drop") {
          setTargeted(false);
          const path = payload.paths[0];
          if (path && model.isIdle) void model.transcribeFile(path);
        } else {
          setTargeted(false);
        }
      }).then((f) => (unlisten = f)));
    return () => unlisten?.();
  }, [model, setTargeted]);
}
