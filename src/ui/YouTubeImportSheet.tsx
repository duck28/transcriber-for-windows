import { SquarePlay } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { backend } from "../model/backend";
import { useModel } from "../model/TranscriptionModel";
import { YTDLPStatus } from "./Pieces";

function youTubeURL(text: string): string | null {
  try {
    const url = new URL(text.trim());
    const host = url.hostname.toLowerCase();
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (host !== "youtu.be" && host !== "youtube.com" && !host.endsWith(".youtube.com")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function YouTubeImportSheet() {
  const model = useModel();
  const [link, setLink] = useState("");
  const [useCaptions, setUseCaptions] = useState(true);
  const field = useRef<HTMLInputElement>(null);
  const video = youTubeURL(link);
  const dismiss = () => model.setShowYouTubeImport(false);
  const canImport = video !== null && model.ytDLP !== null;

  const importVideo = () => {
    if (!video || !canImport) return;
    dismiss();
    void model.importYouTube(video, useCaptions);
  };

  useEffect(() => {
    field.current?.focus();
    // Offer a YouTube link that's already on the clipboard.
    void backend.readClipboard().then((copied) => {
      if (youTubeURL(copied)) setLink((current) => current || copied.trim());
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && dismiss()}>
      <form className="sheet sheet-content" role="dialog" aria-labelledby="youtube-title"
            onSubmit={(e) => {
              e.preventDefault();
              importVideo();
            }}>
        <div className="sheet-header">
          <SquarePlay size={30} color="var(--red)" fill="color-mix(in srgb, var(--red) 25%, transparent)" />
          <div>
            <h2 id="youtube-title">Import from YouTube</h2>
            <span className="callout secondary">Language: {model.selectedLanguageName}</span>
          </div>
        </div>

        <div className="text-field glass">
          <input ref={field} value={link} onChange={(e) => setLink(e.target.value)} aria-label="Video link"
                 placeholder="https://www.youtube.com/watch?v=…" spellCheck={false} />
        </div>

        <div className="radio-group" role="radiogroup" aria-label="Method">
          <label className="radio">
            <input type="radio" checked={useCaptions} onChange={() => setUseCaptions(true)} />
            Use YouTube's captions if there are any (fast)
          </label>
          <label className="radio">
            <input type="radio" checked={!useCaptions} onChange={() => setUseCaptions(false)} />
            Download the audio and transcribe it on this PC
          </label>
        </div>

        <span className="caption secondary">If the video has no captions in this language, the audio is transcribed instead.</span>

        <YTDLPStatus tool={model.ytDLP} isChecking={model.isCheckingYTDLP} installCommand={model.ytDLPInstallCommand} />

        <div className="sheet-buttons">
          <button type="button" className="glass-button large" onClick={dismiss}>Cancel</button>
          <button type="submit" className="glass-button large prominent" disabled={!canImport}>Import</button>
        </div>
      </form>
    </div>
  );
}
