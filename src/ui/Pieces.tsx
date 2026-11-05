import { Copy, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { backend, type YTDLPTool } from "../model/backend";
import type { Activity, Dialog } from "../model/TranscriptionModel";
import { ContextMenu, item } from "./Menu";

/**
 * A field for renaming in place. Enter or clicking elsewhere finishes with the new name, Escape with null.
 * `selectStem` selects the name without its extension, like File Explorer.
 */
export function NameField({ value, placeholder, className, selectStem = false, onDone }: {
  value: string;
  placeholder?: string;
  className: string;
  selectStem?: boolean;
  onDone: (name: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    const field = input.current!;
    field.focus();
    const dot = selectStem ? value.lastIndexOf(".") : -1;
    field.setSelectionRange(0, dot > 0 ? dot : value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const finish = (name: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(name);
  };
  return (
    <input ref={input} className={className} defaultValue={value} placeholder={placeholder} spellCheck={false}
           onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
           onDoubleClick={(e) => e.stopPropagation()}
           onKeyDown={(e) => {
             e.stopPropagation();
             if (e.key === "Enter") finish(e.currentTarget.value);
             else if (e.key === "Escape") finish(null);
           }}
           onBlur={(e) => finish(e.currentTarget.value)} />
  );
}

export function SegmentRow({ timestamp, text }: {
  /** null for the text that is still being recognized. */
  timestamp: string | null;
  text: string;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <div className={`row${timestamp === null ? " partial" : ""}`}
         onContextMenu={(e) => {
           e.preventDefault();
           setMenu({ x: e.clientX, y: e.clientY });
         }}>
      <time>{timestamp ?? ""}</time>
      <p>{text}</p>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}
                     entries={[item("Copy Paragraph", () => void backend.copyText(text), { icon: <Copy size={13} /> })]} />
      )}
    </div>
  );
}

export function RecordButton({ isRunning, disabled, onClick }: { isRunning: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button className={`record-button glass${isRunning ? " running" : ""}`} disabled={disabled} onClick={onClick}
            aria-label={isRunning ? "Stop" : "Start"} title={isRunning ? "Stop transcribing (Ctrl+R)" : "Start transcribing (Ctrl+R)"}>
      {isRunning && <span className="pulse" />}
      <span className="shape" />
    </button>
  );
}

/** Maps RMS to a perceptual 0...1 range (-60 dB ... 0 dB). */
const normalized = (level: number) => Math.min(Math.max((20 * Math.log10(Math.max(level, 0.000_001)) + 60) / 60, 0), 1);

/** A scrolling bar graph of the recent audio level. */
export function Waveform({ level, isActive }: { level: number; isActive: boolean }) {
  const [history, setHistory] = useState<number[]>(() => Array(24).fill(0));
  const peak = useRef(0);
  const lastPush = useRef(0);

  useEffect(() => {
    // Levels arrive often; keep the loudest and add one bar every ~70 ms.
    peak.current = Math.max(peak.current, normalized(level));
    const now = performance.now();
    if (now - lastPush.current <= 70) return;
    const value = peak.current;
    peak.current = 0;
    lastPush.current = now;
    setHistory((h) => [...h.slice(1), value]);
  }, [level]);

  useEffect(() => {
    if (!isActive) setHistory(Array(24).fill(0));
  }, [isActive]);

  return (
    <div className={`waveform${isActive ? " active" : ""}`} title="Audio level" aria-hidden="true">
      {history.map((value, index) => <span key={index} style={{ height: Math.max(3, value * 22) }} />)}
    </div>
  );
}

function ProgressRing({ value }: { value: number }) {
  const radius = 6.5;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg className="progress-ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r={radius} fill="none" stroke="var(--fill-strong)" strokeWidth="2.2" />
      <circle cx="8" cy="8" r={radius} fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round"
              strokeDasharray={circumference} strokeDashoffset={circumference * (1 - Math.min(Math.max(value, 0), 1))}
              transform="rotate(-90 8 8)" />
    </svg>
  );
}

export function ActivityCard({ activity, onCancel }: { activity: Activity; onCancel: () => void }) {
  return (
    <div className="activity glass">
      {activity.progress !== null ? <ProgressRing value={activity.progress} /> : <div className="spinner" />}
      <span className="activity-title">{activity.title}</span>
      {activity.progress !== null && <span className="secondary mono-digits">{Math.round(activity.progress * 100)}%</span>}
      <button className="glass-button small" onClick={onCancel}>Cancel</button>
    </div>
  );
}

export function NoticeCard({ text, icon, tint, onClose, action }: {
  text: string;
  icon: ReactNode;
  tint: string;
  onClose?: () => void;
  action?: { title: string; perform: () => void } | null;
}) {
  return (
    <div className="notice glass">
      <span style={{ color: tint, display: "flex" }}>{icon}</span>
      <div className="notice-body">
        <span>{text}</span>
        {action && <button className="glass-button small" onClick={action.perform}>{action.title}</button>}
      </div>
      {onClose && (
        <button className="notice-close" title="Dismiss" aria-label="Dismiss" onClick={onClose}>
          <X size={12} strokeWidth={3} />
        </button>
      )}
    </div>
  );
}

/** Copies `text` and says so for a moment. type="button", so it doesn't submit a form it's in. */
function CopyButton({ text }: { text: string }) {
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), 1500);
    return () => clearTimeout(timer);
  }, [result]);
  const copy = () => {
    backend.copyText(text).then(() => setResult("copied"), () => setResult("failed"));
  };
  return (
    <button type="button" className="small-button" onClick={copy}>
      {result === "copied" ? "Copied" : result === "failed" ? "Couldn't copy" : "Copy"}
    </button>
  );
}

/** Which yt-dlp is used, and how to install or update it. */
export function YTDLPStatus({ tool, isChecking, installCommand }: {
  tool: YTDLPTool | null;
  isChecking: boolean;
  installCommand: string;
}) {
  const warning = (text: string, command: string) => (
    <div className="warning">
      <span className="warning-label"><TriangleAlert size={13} style={{ marginTop: 1 }} />{text}</span>
      <span className="command">
        <code>{command}</code>
        <CopyButton text={command} />
      </span>
    </div>
  );
  let content: ReactNode;
  if (tool) {
    content = tool.isOutdated
      ? warning(`yt-dlp ${tool.version} is out of date, and YouTube regularly breaks older versions. Update it in a terminal:`, tool.updateCommand)
      : <span className="secondary">Using yt-dlp {tool.version} ({tool.path})</span>;
  } else if (isChecking) {
    content = <span className="secondary">Looking for yt-dlp…</span>;
  } else {
    content = warning("Importing from YouTube needs yt-dlp. Install it in a terminal, then come back to Transcriber:", installCommand);
  }
  return <div className="ytdlp-status">{content}</div>;
}

/** An alert in the middle of the window, like NSAlert. */
export function AlertView({ dialog }: { dialog: Dialog }) {
  const defaultButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    defaultButton.current?.focus();
    const cancelIndex = dialog.buttons.findIndex((b) => b.role === "cancel");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && cancelIndex >= 0) {
        e.preventDefault();
        dialog.answer(cancelIndex);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dialog]);

  return (
    <div className="scrim centered">
      <div className="alert" role="alertdialog" aria-labelledby="alert-message">
        <img src="/icon.png" alt="" />
        <h2 id="alert-message">{dialog.message}</h2>
        <p>{dialog.information}</p>
        <div className="alert-buttons">
          {dialog.buttons.map((button, index) => (
            <button key={index} ref={button.role === "default" ? defaultButton : undefined}
                    className={`glass-button large${button.role === "default" ? " prominent" : ""}`}
                    onClick={() => dialog.answer(index)}>
              {button.title}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
