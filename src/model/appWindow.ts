// The window this interface runs in: the main window or Settings. Draws its own title bar, so it needs
// minimize, maximize and close itself. In the browser preview these do nothing (or open a tab).

import { isTauri } from "./backend";

type Unlisten = () => void;

export interface AppWindow {
  /** "main" or "settings". */
  label: string;
  minimize(): void;
  toggleMaximize(): void;
  isMaximized(): Promise<boolean>;
  onResized(handler: () => void): Promise<Unlisten>;
  /** Asks to close; the main window may veto it in `onCloseRequested`. */
  close(): void;
  /** Closes without asking. */
  destroy(): void;
  onCloseRequested(handler: () => Promise<boolean>): Promise<Unlisten>;
  setHeight(height: number): void;
  openSettings(): Promise<void>;
}

async function makeTauriWindow(): Promise<AppWindow> {
  const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWindow();
  return {
    label: current.label,
    minimize: () => void current.minimize(),
    toggleMaximize: () => void current.toggleMaximize(),
    isMaximized: () => current.isMaximized(),
    onResized: (handler) => current.onResized(handler),
    close: () => void current.close(),
    destroy: () => void current.destroy(),
    onCloseRequested: (handler) =>
      current.onCloseRequested(async (event) => {
        event.preventDefault();
        if (await handler()) await current.destroy();
      }),
    setHeight: (height) => void current.setSize(new LogicalSize(480, Math.ceil(height))),
    openSettings: async () => {
      const existing = await WebviewWindow.getByLabel("settings");
      if (existing) {
        await existing.show();
        await existing.setFocus();
        return;
      }
      new WebviewWindow("settings", {
        url: "index.html#settings",
        title: "Settings",
        width: 480,
        height: 600,
        resizable: false,
        maximizable: false,
        minimizable: false,
        decorations: false,
        shadow: true,
        center: true,
      });
    },
  };
}

function makePreviewWindow(): AppWindow {
  const label = location.hash === "#settings" ? "settings" : "main";
  return {
    label,
    minimize: () => {},
    toggleMaximize: () => {},
    isMaximized: async () => false,
    onResized: async () => () => {},
    close: () => window.close(),
    destroy: () => window.close(),
    onCloseRequested: async () => () => {},
    setHeight: () => {},
    openSettings: async () => void window.open(location.pathname + "#settings", "settings", "width=480,height=640"),
  };
}

export const appWindow: AppWindow = isTauri ? await makeTauriWindow() : makePreviewWindow();
