<p align="center"><img src="public/icon.png" width="112" alt="Transcriber"></p>

# Transcriber for Windows

Transcribes whatever your PC is playing (calls, videos, podcasts), a microphone, recorded audio files and YouTube videos. Speech recognition runs on your PC with [Whisper](https://github.com/ggerganov/whisper.cpp), so audio never leaves the computer. It also turns a voiceover into word-timed subtitles for video editors.

It's the Windows version of [Transcriber for Mac](https://github.com/duck28/transcriber-for-mac) and looks and works the same way.

## Features

- **Sources:** system audio (WASAPI loopback) or any microphone or audio interface.
- **Files and YouTube:** import audio and video files, or a YouTube video (its captions, or its audio transcribed on your PC).
- **Narrator mode:** turns a voiceover into subtitles timed to each word, exported as SubRip (`.srt`), WebVTT (`.vtt`) or Final Cut Pro XML (`.fcpxml`, which DaVinci Resolve imports too).
- **Transcripts folder:** a sidebar with the save folder: make folders, rename, move and delete transcripts.
- **Auto-save** after every segment, **Save Audio** as a `.wav` next to the transcript, and a warning before closing with unsaved work.
- **Whisper models:** *Large v3 Turbo – fast* (≈ 550 MB, the default), full precision and smaller models, or a custom whisper.cpp model from Hugging Face. Models are downloaded once into `%APPDATA%\Transcriber\Whisper`; after that, transcription works offline. Expert options expose Whisper's decoding parameters.

### Differences from the Mac app

| | Mac | Windows |
| --- | --- | --- |
| Speech | Apple Speech or Whisper (WhisperKit, Core ML) | Whisper only (whisper.cpp, Vulkan GPU or CPU) |
| Shortcuts | ⌘ | Ctrl (Ctrl+R start/stop, Ctrl+N new, Ctrl+O file, Ctrl+Shift+Y YouTube, Ctrl+Shift+N narrator mode, Ctrl+Shift+S save as, Ctrl+, settings) |
| Menus | Menu bar | No menu bar; Settings has a toolbar button |
| Save Audio | `.m4a` | `.wav` |
| Final Cut Pro | Export and *Open in Final Cut Pro* | Export only |
| yt-dlp | Homebrew, pip | PATH, winget, Scoop, Chocolatey and pip locations (`winget install yt-dlp.yt-dlp`) |

## Download and install

Requires Windows 10 or 11 (64-bit) with the WebView2 runtime, which Windows 11 already has (the installer adds it on Windows 10 if needed).

Each release has two variants. Pick one from the [latest release](https://github.com/duck28/transcriber-for-windows/releases/latest):

- **GPU** (`Transcriber_<version>_x64_gpu-setup.exe`): runs Whisper on the graphics card through Vulkan (Intel, AMD and NVIDIA). Much faster; recommended for live transcription.
- **CPU** (`Transcriber_<version>_x64_cpu-setup.exe`): runs Whisper on the processor only. Use it if the GPU version doesn't start or your graphics driver has no Vulkan support.

Both are also available as `.msi` packages (`…_gpu_en-US.msi`, `…_cpu_en-US.msi`) for installing with administrator rights. The `.exe` installers install for your user account and need no administrator rights.

### The installers are not code-signed

The installers aren't signed with a code-signing certificate, so Windows doesn't know who published them:

- Your browser may say the file *isn't commonly downloaded*. In Edge, choose **⋯ › Keep**, then **Show more › Keep anyway**.
- When you run it, Microsoft Defender SmartScreen shows **Windows protected your PC**. Click **More info**, then **Run anyway**.

### Verify a download

Every release file is attested by the GitHub Actions run that built it ([build provenance](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations)). With the [GitHub CLI](https://cli.github.com):

```powershell
gh attestation verify Transcriber_1.3.0_x64_gpu-setup.exe --repo duck28/transcriber-for-windows
```

## Build from source

Built with [Tauri 2](https://tauri.app): a Rust backend (`src-tauri/`) and a React interface (`src/`) that reproduces the Mac app's look (Inter in place of SF Pro, Lucide in place of SF Symbols).

Needs Node.js 22+, Rust, the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (Microsoft C++ Build Tools, WebView2), CMake and LLVM (for whisper.cpp). For GPU acceleration, also install the [Vulkan SDK](https://vulkan.lunarg.com/sdk/home#windows).

```powershell
npm install
npx tauri build --features vulkan   # or without --features vulkan for CPU only
```

The installers end up in `src-tauri/target/release/bundle/` (`nsis/*.exe` and `msi/*.msi`).

- `npx tauri dev` runs the app with live reload.
- `npm run dev` opens the interface in a browser with a simulated backend (sample transcription, fake files and devices), which is enough to work on the design, also on a Mac. `http://localhost:1420/#settings` shows the Settings window.
- `cargo test` (in `src-tauri/`) runs the unit tests.
- The [build workflow](.github/workflows/build.yml) builds both variants for every push to `main` and every pull request.
- `src-tauri/.cargo/config.toml` passes `/O2` to the MSVC compiler through `CL`, because otherwise whisper.cpp is built without optimization and runs many times slower.

## Releasing

1. Set the same new version (for example `1.3.1`) in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, and build once so `Cargo.lock` and `package-lock.json` follow.
2. Commit, then push a tag that matches the version with a `v` in front:
   ```powershell
   git tag v1.3.1; git push origin v1.3.1
   ```
3. The [release workflow](.github/workflows/release.yml) checks that the tag matches all three versions, builds the GPU and CPU installers on Windows runners, attests them, and creates a **draft** release. Review it on GitHub and publish it.

## Code

| Part | File |
| --- | --- |
| App state | `src/model/TranscriptionModel.ts` |
| Whisper (whisper.cpp) | `src-tauri/src/whisper.rs` |
| Live transcription | `src-tauri/src/live.rs` |
| Audio files (Symphonia) | `src-tauri/src/file.rs` |
| System audio and microphones (WASAPI) | `src-tauri/src/audio.rs` |
| YouTube (yt-dlp) | `src-tauri/src/youtube.rs` |
| Transcript folder | `src-tauri/src/library.rs`, `src/model/library.ts`, `src/ui/Sidebar.tsx` |
| Subtitles (SRT, WebVTT, FCPXML) | `src/model/subtitles.ts` |
| Interface | `src/ui/` and `src/styles.css` |

## License

[MIT](LICENSE)
