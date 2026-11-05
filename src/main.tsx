import "@fontsource-variable/inter";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { appWindow } from "./model/appWindow";

// One bundle serves both windows; the window's label says which one this is.
const root = createRoot(document.getElementById("root")!);

if (appWindow.label === "settings") {
  const { SettingsView } = await import("./ui/SettingsView");
  root.render(<StrictMode><SettingsView /></StrictMode>);
} else {
  const { ContentView } = await import("./ui/ContentView");
  const { model } = await import("./model/TranscriptionModel");
  // Ask before closing while work is running or the transcript isn't saved.
  void appWindow.onCloseRequested(model.shouldClose);
  void model.launch();
  root.render(<StrictMode><ContentView /></StrictMode>);
}

// No browser context menu (Reload, Inspect…) except where the app offers its own.
document.addEventListener("contextmenu", (e) => {
  if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
});
