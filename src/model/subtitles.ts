// Subtitles for narrator mode. A direct port of Subtitles.swift.

/** A recognized word and when it was spoken, in seconds. */
export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

/** One subtitle: up to two lines of text shown from `start` to `end` (seconds). */
export interface SubtitleCue {
  start: number;
  end: number;
  lines: string[];
}

export const cueText = (cue: SubtitleCue) => cue.lines.join(" ");

/** How much text a subtitle may hold. */
export type SubtitleStyle = "standard" | "shortForm";

export const SUBTITLE_STYLES: { id: SubtitleStyle; title: string }[] = [
  { id: "standard", title: "Standard: 2 lines of up to 42 characters" },
  { id: "shortForm", title: "Short-form video: 1 line of up to 32 characters" },
];

const limits = (style: SubtitleStyle) =>
  style === "standard"
    ? { maxCharactersPerLine: 42, maxLines: 2, maxDuration: 7 }
    : { maxCharactersPerLine: 32, maxLines: 1, maxDuration: 3.5 };

export type SubtitleFormat = "srt" | "webVTT" | "finalCutPro";

export const SUBTITLE_FORMATS: { id: SubtitleFormat; fileExtension: string; menuTitle: string; filterName: string }[] = [
  { id: "srt", fileExtension: "srt", menuTitle: "SubRip (.srt) – DaVinci Resolve, Premiere Pro…", filterName: "SubRip" },
  { id: "webVTT", fileExtension: "vtt", menuTitle: "WebVTT (.vtt)…", filterName: "WebVTT" },
  { id: "finalCutPro", fileExtension: "fcpxml", menuTitle: "Final Cut Pro Project (.fcpxml)…", filterName: "FCPXML" },
];

/** Frame rates offered for Final Cut Pro projects. Caption times are snapped to frames. */
export type VideoFrameRate = "23.976" | "24" | "25" | "29.97" | "30" | "50" | "59.94" | "60";

export const FRAME_RATES: VideoFrameRate[] = ["23.976", "24", "25", "29.97", "30", "50", "59.94", "60"];

/** The length of one frame as a fraction of a second. */
function frameDuration(rate: VideoFrameRate): [number, number] {
  switch (rate) {
    case "23.976": return [1001, 24000];
    case "24": return [100, 2400];
    case "25": return [100, 2500];
    case "29.97": return [1001, 30000];
    case "30": return [100, 3000];
    case "50": return [100, 5000];
    case "59.94": return [1001, 60000];
    case "60": return [100, 6000];
  }
}

function formatName(rate: VideoFrameRate): string {
  switch (rate) {
    case "23.976": return "FFVideoFormat1080p2398";
    case "29.97": return "FFVideoFormat1080p2997";
    case "59.94": return "FFVideoFormat1080p5994";
    default: return `FFVideoFormat1080p${rate}`;
  }
}

const isDropFrame = (rate: VideoFrameRate) => rate === "29.97" || rate === "59.94";

// MARK: - Building cues

/** Every subtitle stays up at least this long, if the next one allows it. */
const MIN_DURATION = 1;
/** A pause this long in speech starts a new subtitle. */
const PAUSE_BREAK = 0.6;
/** Subtitles stay up this much longer than the last word, if the next one allows it. */
const HOLD = 0.4;
/** The smallest gap left between two subtitles. */
const MIN_GAP = 0.05;

/**
 * Groups words into subtitles, starting a new one at the end of a sentence, at pauses,
 * and whenever the text or duration would exceed what `style` allows.
 */
export function buildCues(words: TimedWord[], style: SubtitleStyle): SubtitleCue[] {
  const { maxCharactersPerLine, maxLines, maxDuration } = limits(style);
  const cues: SubtitleCue[] = [];
  let current: TimedWord[] = [];
  const join = (list: TimedWord[]) => list.map((w) => w.text).join(" ");

  const close = () => {
    const first = current[0];
    const last = current[current.length - 1];
    if (!first || !last) return;
    const text = join(current);
    cues.push({ start: first.start, end: Math.max(last.end, first.start), lines: layout(text, style) ?? [text] });
    current = [];
  };

  for (const word of words) {
    const first = current[0];
    const last = current[current.length - 1];
    if (first && last) {
      const text = join([...current, word]);
      if (word.start - last.end >= PAUSE_BREAK || word.end - first.start > maxDuration || layout(text, style) === null) {
        close();
      }
    }
    current.push(word);

    const length = [...join(current)].length;
    const capacity = maxCharactersPerLine * maxLines;
    const mark = word.text[word.text.length - 1];
    if (mark && ".?!…".includes(mark)) {
      close();
    } else if (word.text.endsWith(",") && length * 10 >= capacity * 6) {
      close();
    }
  }
  close();
  return adjustTiming(cues);
}

/**
 * Splits `text` into at most `maxLines` lines that each fit, with line lengths as even as possible.
 * Returns null if the text doesn't fit.
 */
export function layout(text: string, style: SubtitleStyle): string[] | null {
  const { maxCharactersPerLine: limit, maxLines } = limits(style);
  const count = (s: string) => [...s].length;
  if (count(text) <= limit) return [text];
  if (maxLines < 2) return null;

  const words = text.split(" ");
  let best: { lines: string[]; score: number } | null = null;
  for (let split = 1; split < Math.max(words.length, 1); split++) {
    const first = words.slice(0, split).join(" ");
    const second = words.slice(split).join(" ");
    if (count(first) > limit || count(second) > limit) continue;
    let score = Math.abs(count(first) - count(second));
    // Breaking after punctuation reads more naturally.
    if (",;:.?!".includes(first[first.length - 1])) score -= 10;
    if (!best || score < best.score) best = { lines: [first, second], score };
  }
  return best?.lines ?? null;
}

/** Lengthens subtitles a little past their last word, without overlapping the next one. */
function adjustTiming(cues: SubtitleCue[]): SubtitleCue[] {
  const result = cues.map((cue) => ({ ...cue }));
  result.forEach((cue, index) => {
    const nextStart = index + 1 < result.length ? result[index + 1].start - MIN_GAP : Infinity;
    const wanted = Math.max(cue.end + HOLD, cue.start + MIN_DURATION);
    cue.end = Math.min(wanted, nextStart);
    if (cue.end <= cue.start) cue.end = cue.start + 0.1;
  });
  return result;
}

// MARK: - Writing files

function timestamp(seconds: number, separator: string): string {
  const ms = Math.round(Math.max(seconds, 0) * 1000);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
}

export function srt(cues: SubtitleCue[]): string {
  return cues
    .map((cue, index) => `${index + 1}\n${timestamp(cue.start, ",")} --> ${timestamp(cue.end, ",")}\n${cue.lines.join("\n")}\n`)
    .join("\n");
}

export function webVTT(cues: SubtitleCue[]): string {
  return "WEBVTT\n\n" + cues.map((cue) => `${timestamp(cue.start, ".")} --> ${timestamp(cue.end, ".")}\n${cue.lines.join("\n")}\n`).join("\n");
}

/** Details of the voiceover file that the Final Cut Pro project references. */
export interface AudioInfo {
  path: string;
  duration: number;
  channels: number;
  sampleRate: number;
}

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** file:///C:/Users/… for a Windows path. */
export function fileURL(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return "file://" + (normalized.startsWith("/") ? "" : "/") + encodeURI(normalized).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

const baseName = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]*$/, "");

/**
 * A Final Cut Pro project (FCPXML 1.10, Final Cut Pro 10.6 or later; DaVinci Resolve imports it too)
 * with the voiceover on the timeline and the subtitles as captions attached to it.
 */
export function finalCutPro(cues: SubtitleCue[], audio: AudioInfo, title: string, languageCode: string,
                            frameRate: VideoFrameRate): string {
  const [value, timescale] = frameDuration(frameRate);
  const frameSeconds = value / timescale;
  const frames = (seconds: number) => Math.round(seconds / frameSeconds);
  const time = (count: number) => (count === 0 ? "0s" : `${count * value}/${timescale}s`);

  const lastCueEnd = cues.length ? frames(cues[cues.length - 1].end) : 0;
  const total = Math.max(Math.ceil(audio.duration / frameSeconds), lastCueEnd, 1);
  const starts = cues.map((cue) => frames(cue.start));
  const role = `SRT?captionFormat=SRT.${languageCode}`;

  const captions = cues.map((cue, index) => {
    const start = starts[index];
    const limit = index + 1 < starts.length ? starts[index + 1] : total;
    const end = Math.min(Math.max(frames(cue.end), start + 1), Math.max(limit, start + 1));
    const text = escape(cue.lines.join("\n"));
    const name = escape([...cueText(cue)].slice(0, 40).join(""));
    return `                                <caption lane="1" offset="${time(start)}" name="${name}" duration="${time(end - start)}" role="${role}">
                                    <text placement="bottom">
                                        <text-style ref="ts${index + 1}">${text}</text-style>
                                    </text>
                                    <text-style-def id="ts${index + 1}">
                                        <text-style font="Helvetica" fontSize="13" fontFace="Regular" fontColor="1 1 1 1" backgroundColor="0 0 0 1"/>
                                    </text-style-def>
                                </caption>`;
  });

  const clipName = escape(baseName(audio.path));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
    <resources>
        <format id="r1" name="${formatName(frameRate)}" frameDuration="${value}/${timescale}s" width="1920" height="1080"/>
        <asset id="r2" name="${clipName}" start="0s" duration="${time(total)}" hasAudio="1" audioSources="1" audioChannels="${audio.channels}" audioRate="${audio.sampleRate}">
            <media-rep kind="original-media" src="${escape(fileURL(audio.path))}"/>
        </asset>
    </resources>
    <library>
        <event name="Transcriber">
            <project name="${escape(title)}">
                <sequence format="r1" duration="${time(total)}" tcStart="0s" tcFormat="${isDropFrame(frameRate) ? "DF" : "NDF"}" audioLayout="stereo" audioRate="48k">
                    <spine>
                        <asset-clip ref="r2" offset="0s" name="${clipName}" duration="${time(total)}" audioRole="dialogue">
${captions.join("\n")}
                        </asset-clip>
                    </spine>
                </sequence>
            </project>
        </event>
    </library>
</fcpxml>
`;
}
