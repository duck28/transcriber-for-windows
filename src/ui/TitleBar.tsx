import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { appWindow } from "../model/appWindow";
import { NameField } from "./Pieces";

/**
 * The window's title bar: title and subtitle on the left and the toolbar on the right, like the Mac app's
 * unified toolbar, followed by the Windows caption buttons. Drag it to move the window.
 * With `rename`, clicking the title lets you change it.
 */
export function TitleBar({ title, subtitle, children, leading, rename, resizable = true }: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
  /** Shown before the title. */
  leading?: ReactNode;
  rename?: { value: string; placeholder: string; onRename: (title: string) => void };
  resizable?: boolean;
}) {
  const [maximized, setMaximized] = useState(false);
  const [isRenaming, setRenaming] = useState(false);
  useEffect(() => {
    const update = () => void appWindow.isMaximized().then(setMaximized);
    update();
    const unlisten = appWindow.onResized(update);
    return () => void unlisten.then((f) => f());
  }, []);

  return (
    <header className="titlebar" data-tauri-drag-region>
      {leading}
      <div className="titlebar-title" data-tauri-drag-region>
        {rename && isRenaming ? (
          <NameField className="form-input title-field" value={rename.value} placeholder={rename.placeholder}
                     onDone={(name) => {
                       setRenaming(false);
                       if (name !== null) rename.onRename(name);
                     }} />
        ) : rename ? (
          <button className="title-button" title="Rename" onClick={() => setRenaming(true)}>
            <strong>{title}</strong>
          </button>
        ) : (
          <strong>{title}</strong>
        )}
        {subtitle && <span>{subtitle}</span>}
      </div>
      {children}
      <div className="caption-buttons">
        {resizable && (
          <>
            <button className="caption-button" aria-label="Minimize" title="Minimize" onClick={appWindow.minimize}>
              <Minus size={15} strokeWidth={1.25} />
            </button>
            <button className="caption-button" aria-label={maximized ? "Restore" : "Maximize"}
                    title={maximized ? "Restore Down" : "Maximize"} onClick={appWindow.toggleMaximize}>
              {maximized ? <Copy size={12} strokeWidth={1.25} style={{ transform: "scaleX(-1)" }} />
                         : <Square size={12} strokeWidth={1.25} />}
            </button>
          </>
        )}
        <button className="caption-button close" aria-label="Close" title="Close" onClick={appWindow.close}>
          <X size={16} strokeWidth={1.25} />
        </button>
      </div>
    </header>
  );
}
