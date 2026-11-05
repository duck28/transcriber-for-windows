import { ChevronsUpDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { appWindow } from "../model/appWindow";
import { backend } from "../model/backend";
import {
  APPEARANCES, applyAppearance, DEFAULT_WHISPER_PARAMETERS, DEFAULT_WHISPER_REPO, loadSettings, storeSetting,
  WHISPER_MODELS, type ModelStatus, type Settings, type WhisperParameters,
} from "../model/settings";
import { FRAME_RATES, SUBTITLE_STYLES } from "../model/subtitles";
import { item, MenuButton } from "./Menu";
import { YTDLPStatus } from "./Pieces";
import { TitleBar } from "./TitleBar";

/**
 * Settings, in their own window like on the Mac. Preferences are shared with the main window through storage;
 * the main window reports its state (`model-status`) and does what needs it (`model-action`).
 */
export function SettingsView() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    applyAppearance(settings.appearance);
    const unlisteners = [
      backend.listen<ModelStatus>("model-status", setStatus),
      backend.listen<{ key: keyof Settings; value: never }>("settings-changed", ({ key, value }) =>
        setSettings((s) => {
          if (key === "appearance") applyAppearance(value);
          return { ...s, [key]: value };
        })),
    ];
    void backend.broadcast("settings-opened");
    return () => unlisteners.forEach((u) => void u.then((f) => f()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The window fits its content, like a SwiftUI Settings window.
  useLayoutEffect(() => {
    const element = root.current!;
    const observer = new ResizeObserver(() => appWindow.setHeight(element.scrollHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || (e.ctrlKey && e.key.toLowerCase() === "w")) appWindow.close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
    storeSetting(key, value);
    if (key === "appearance") applyAppearance(value as Settings["appearance"]);
  };
  const setParameter = <K extends keyof WhisperParameters>(key: K, value: WhisperParameters[K]) =>
    set("whisperParameters", { ...settings.whisperParameters, [key]: value });
  const parameters = settings.whisperParameters;

  const isIdle = status?.isIdle ?? true;
  const saveFolder = settings.saveFolder || status?.defaultSaveFolder || "";
  const whisperModel = WHISPER_MODELS.find((m) => m.id === settings.whisperModel) ?? WHISPER_MODELS[0];

  return (
    <div className="window settings" ref={root} style={{ height: "auto" }}>
      <TitleBar title="Settings" resizable={false} />
      <div className="form">
        <div className="form-box">
          <Row label="Appearance">
            <Segmented value={settings.appearance} options={APPEARANCES} onChange={(v) => set("appearance", v)} />
          </Row>
        </div>

        <Section title="Speech Recognition" disabled={!isIdle}>
          <Row label="Whisper model">
            <PopUp value={whisperModel.title} entries={WHISPER_MODELS.map((m) => ({
              title: m.title, checked: m.id === settings.whisperModel, action: () => set("whisperModel", m.id),
            }))} disabled={!isIdle} />
          </Row>
          {settings.whisperModel === "custom" && (
            <>
              <Row label="Hugging Face repository">
                <TextField value={settings.whisperCustomRepo} placeholder={DEFAULT_WHISPER_REPO} disabled={!isIdle}
                           onChange={(v) => set("whisperCustomRepo", v)} />
              </Row>
              <Row label="Model file">
                <TextField value={settings.whisperCustomFile} placeholder="ggml-large-v3-turbo.bin" disabled={!isIdle}
                           onChange={(v) => set("whisperCustomFile", v)} />
              </Row>
            </>
          )}
          <Row label="Status">
            <span className="secondary">{status?.isWhisperModelDownloaded ? "On this PC" : "Not downloaded"}</span>
            {status && !status.isWhisperModelDownloaded && (
              <button className="plain-button" disabled={!isIdle || !status.hasWhisperModelSource}
                      onClick={() => void backend.broadcast("model-action", "downloadWhisperModel")}>Download</button>
            )}
            <button className="plain-button" onClick={async () => backend.openPath(await backend.modelsFolder())}>
              Show in Explorer
            </button>
          </Row>
          <Footnote>
            Whisper runs on this PC and understands Swiss German and other dialects, writing them as Standard German (with
            Swiss spelling when German (Switzerland) is selected). The model is downloaded once. “Fast” is about twice as
            quick as full precision with nearly the same accuracy.
          </Footnote>
        </Section>

        <Section title="Expert Options">
          <Row label="Change transcription parameters">
            <Switch on={settings.expertOptions} onChange={(v) => set("expertOptions", v)} />
          </Row>
          {settings.expertOptions && (
            <>
              <Row label="Beam size">
                <NumberField value={parameters.beamSize} min={1} max={8} step={1}
                             onChange={(v) => setParameter("beamSize", Math.round(v))} />
              </Row>
              <Row label="Temperature">
                <NumberField value={parameters.temperature} min={0} max={1} step={0.1}
                             onChange={(v) => setParameter("temperature", v)} />
              </Row>
              <Row label="Temperature increase on retry">
                <NumberField value={parameters.temperatureIncrement} min={0} max={1} step={0.1}
                             onChange={(v) => setParameter("temperatureIncrement", v)} />
              </Row>
              <Row label="Entropy threshold">
                <NumberField value={parameters.entropyThreshold} min={0} max={10} step={0.1}
                             onChange={(v) => setParameter("entropyThreshold", v)} />
              </Row>
              <Row label="Log probability threshold">
                <NumberField value={parameters.logProbThreshold} min={-10} max={0} step={0.1}
                             onChange={(v) => setParameter("logProbThreshold", v)} />
              </Row>
              <Row label="No-speech threshold">
                <NumberField value={parameters.noSpeechThreshold} min={0} max={1} step={0.05}
                             onChange={(v) => setParameter("noSpeechThreshold", v)} />
              </Row>
              <Row label="Suppress blank output">
                <Switch on={parameters.suppressBlank} onChange={(v) => setParameter("suppressBlank", v)} />
              </Row>
              <Row label="Suppress non-speech tokens">
                <Switch on={parameters.suppressNonSpeech} onChange={(v) => setParameter("suppressNonSpeech", v)} />
              </Row>
              <Row label="CPU threads (0 = automatic)">
                <NumberField value={parameters.threads} min={0} max={64} step={1}
                             onChange={(v) => setParameter("threads", Math.round(v))} />
              </Row>
              <Row label="Pause that ends a phrase (seconds)">
                <NumberField value={parameters.pauseInterval} min={0.2} max={5} step={0.1}
                             onChange={(v) => setParameter("pauseInterval", v)} />
              </Row>
              <Row label="Longest phrase (seconds)">
                <NumberField value={parameters.maxPhraseDuration} min={5} max={28} step={1}
                             onChange={(v) => setParameter("maxPhraseDuration", v)} />
              </Row>
              <Row label="Silence level">
                <NumberField value={parameters.speechLevel} min={0} max={0.1} step={0.001}
                             onChange={(v) => setParameter("speechLevel", v)} />
              </Row>
              <Row label="Fast live previews">
                <Switch on={parameters.fastPreviews} onChange={(v) => setParameter("fastPreviews", v)} />
              </Row>
              <Row label="Defaults">
                <button className="plain-button"
                        onClick={() => set("whisperParameters", DEFAULT_WHISPER_PARAMETERS)}>Restore Defaults</button>
              </Row>
            </>
          )}
          <Footnote>
            {settings.expertOptions
              ? "The defaults match Transcriber for Mac. A failed decoding is retried at a higher temperature when the " +
                "text repeats itself (entropy) or Whisper is unsure (log probability). Phrase and silence settings apply " +
                "to live transcription; fast previews only affect the text shown while someone is still talking. " +
                "Changes apply to the next transcription."
              : "Transcriber uses the same Whisper parameters as on the Mac. Turn this on to fine-tune them."}
          </Footnote>
        </Section>

        <Section title="Saving">
          <Row label="Save transcripts automatically">
            <Switch on={settings.autosave} onChange={(v) => set("autosave", v)} />
          </Row>
          <Row label="Save audio next to the transcript">
            <Switch on={settings.recordAudio} onChange={(v) => set("recordAudio", v)} />
          </Row>
          <Row label="Folder">
            <span className="path" title={saveFolder}>{saveFolder}</span>
            <button className="plain-button" onClick={async () => {
              const folder = await backend.chooseFolder(saveFolder);
              if (folder) set("saveFolder", folder);
            }}>Choose…</button>
          </Row>
        </Section>

        <Section title="Narrator Mode">
          <Row label="Subtitles">
            <PopUp value={SUBTITLE_STYLES.find((s) => s.id === settings.subtitleStyle)!.title}
                   entries={SUBTITLE_STYLES.map((s) => ({
                     title: s.title, checked: s.id === settings.subtitleStyle, action: () => set("subtitleStyle", s.id),
                   }))} />
          </Row>
          <Row label="Final Cut Pro frame rate">
            <PopUp value={`${settings.frameRate} fps`} entries={FRAME_RATES.map((rate) => ({
              title: `${rate} fps`, checked: rate === settings.frameRate, action: () => set("frameRate", rate),
            }))} />
          </Row>
          <Footnote>
            Subtitles are saved as an .srt file next to the transcript. Changing the style re-flows the current subtitles.
          </Footnote>
        </Section>

        <Section title="YouTube">
          <Row label="yt-dlp location">
            <TextField value={settings.ytDLPPath} placeholder="Find automatically" onChange={(v) => set("ytDLPPath", v)} />
          </Row>
          <div className="form-row stacked">
            <YTDLPStatus tool={status?.ytDLP ?? null} isChecking={status?.isCheckingYTDLP ?? true}
                         installCommand={status?.ytDLPInstallCommand ?? "winget install yt-dlp.yt-dlp"} />
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children, disabled }: { title: string; children: ReactNode; disabled?: boolean }) {
  return (
    <section className={`form-section${disabled ? " disabled-section" : ""}`}>
      <h3>{title}</h3>
      <div className="form-box">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="form-row">
      <span>{label}</span>
      <span className="value">{children}</span>
    </div>
  );
}

function Footnote({ children }: { children: ReactNode }) {
  return <div className="form-row footnote caption">{children}</div>;
}

function Switch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return <button role="switch" aria-checked={on} className={`switch${on ? " on" : ""}`} onClick={() => onChange(!on)} />;
}

function Segmented<T extends string>({ value, options, onChange }: {
  value: T;
  options: { id: T; title: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((option) => (
        <button key={option.id} role="radio" aria-checked={option.id === value}
                className={option.id === value ? "selected" : ""} onClick={() => onChange(option.id)}>
          {option.title}
        </button>
      ))}
    </div>
  );
}

function PopUp({ value, entries, disabled }: {
  value: string;
  entries: { title: string; checked: boolean; action: () => void }[];
  disabled?: boolean;
}) {
  return (
    <MenuButton className="popup" disabled={disabled}
                label={<><span>{value}</span><span className="chevrons"><ChevronsUpDown size={11} strokeWidth={2.5} /></span></>}
                entries={() => entries.map((e) => item(e.title, e.action, { checked: e.checked }))} />
  );
}

/** A number field that stores its value as you type, once it's a number within `min`...`max`. */
function NumberField({ value, min, max, step, onChange }: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  // The typed text is kept separately, so half-typed numbers such as "-" or "0." aren't replaced.
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return <input className="form-input number-input" type="number" value={text} min={min} max={max} step={step}
                onChange={(e) => {
                  setText(e.target.value);
                  const number = e.target.valueAsNumber;
                  if (Number.isFinite(number) && number >= min && number <= max) onChange(number);
                }}
                onBlur={() => setText(String(value))} />;
}

/** A text field that stores its value as you type. */
function TextField({ value, placeholder, onChange, disabled }: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return <input className="form-input" value={value} placeholder={placeholder} disabled={disabled} spellCheck={false}
                onChange={(e) => onChange(e.target.value)} />;
}
