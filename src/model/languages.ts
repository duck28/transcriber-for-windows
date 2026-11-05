/** Languages Whisper understands (its language codes). */
export const WHISPER_LANGUAGE_CODES = new Set(
  ("af am ar as az ba be bg bn bo br bs ca cs cy da de el en es et eu fa fi fo fr gl gu ha haw he hi hr ht hu hy " +
    "id is it ja jw ka kk km kn ko la lb ln lo lt lv mg mi mk ml mn mr ms mt my ne nl nn no oc pa pl ps pt ro ru " +
    "sa sd si sk sl sn so sq sr su sv sw ta te tg th tk tl tr tt uk ur uz vi yi yo yue zh").split(" "),
);

/**
 * The languages offered, as on the Mac (macOS speech recognition's locales that Whisper supports).
 * The region only matters for spelling: German (Switzerland) writes "ss" instead of "ß".
 */
const LOCALE_IDS = [
  "ar-SA", "ca-ES", "cs-CZ", "da-DK", "de-AT", "de-CH", "de-DE", "el-GR",
  "en-AE", "en-AU", "en-CA", "en-GB", "en-ID", "en-IE", "en-IN", "en-NZ", "en-PH", "en-SA", "en-SG", "en-US", "en-ZA",
  "es-CL", "es-CO", "es-ES", "es-MX", "es-US", "fi-FI", "fr-BE", "fr-CA", "fr-CH", "fr-FR", "he-IL", "hi-IN",
  "hr-HR", "hu-HU", "id-ID", "it-CH", "it-IT", "ja-JP", "ko-KR", "ms-MY", "nl-BE", "nl-NL", "pl-PL", "pt-BR",
  "pt-PT", "ro-RO", "ru-RU", "sk-SK", "sv-SE", "th-TH", "tr-TR", "uk-UA", "vi-VN", "yue-CN", "zh-CN", "zh-HK", "zh-TW",
];

const displayNames = (() => {
  try {
    return new Intl.DisplayNames([navigator.language, "en"], { type: "language", languageDisplay: "standard" });
  } catch {
    return null;
  }
})();

/** The locale's name in the user's language, such as "German (Switzerland)". */
export function displayName(id: string): string {
  try {
    return displayNames?.of(id) ?? id;
  } catch {
    return id;
  }
}

/** Whisper's code for the locale's language ("de" for German (Switzerland)), or null if Whisper doesn't know it. */
export function whisperLanguageCode(id: string): string | null {
  const code = id.split("-")[0].toLowerCase();
  return WHISPER_LANGUAGE_CODES.has(code) ? code : null;
}

export function usesSwissSpelling(id: string): boolean {
  return id.split("-")[1]?.toUpperCase() === "CH";
}

/** Every offered language, sorted by name. */
export function availableLocales(): string[] {
  return LOCALE_IDS.filter((id) => whisperLanguageCode(id) !== null).sort((a, b) =>
    displayName(a).localeCompare(displayName(b)),
  );
}

/** The first offered language matching the user's preferred languages. */
export function preferredLocale(candidates: string[]): string | undefined {
  for (const preferred of navigator.languages ?? [navigator.language]) {
    const [language, region] = preferred.split("-");
    const matches = candidates.filter((id) => id.split("-")[0] === language);
    const exact = matches.find((id) => id.split("-")[1]?.toUpperCase() === region?.toUpperCase());
    if (exact ?? matches[0]) return exact ?? matches[0];
  }
  return candidates[0];
}
