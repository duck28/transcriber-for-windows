import { Check } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type MenuEntry =
  | { kind: "item"; title: string; icon?: ReactNode; checked?: boolean; disabled?: boolean; action: () => void }
  | { kind: "separator" }
  | { kind: "section"; title: string };

export const item = (title: string, action: () => void,
                     options: { icon?: ReactNode; checked?: boolean; disabled?: boolean } = {}): MenuEntry =>
  ({ kind: "item", title, action, ...options });
export const separator: MenuEntry = { kind: "separator" };
export const section = (title: string): MenuEntry => ({ kind: "section", title });

/**
 * A button that opens a macOS-style menu. `entries` is evaluated when the menu opens.
 * `onOpen` runs first (to refresh, for example, the list of microphones).
 */
export function MenuButton({ className, label, entries, disabled, title, onOpen, ariaLabel }: {
  className: string;
  label: ReactNode;
  entries: () => MenuEntry[];
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={button} className={className} disabled={disabled} title={title} aria-label={ariaLabel}
              aria-haspopup="menu" aria-expanded={open}
              onMouseDown={(e) => {
                if (e.button !== 0 || disabled) return;
                e.preventDefault();
                onOpen?.();
                setOpen((o) => !o);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
                  e.preventDefault();
                  onOpen?.();
                  setOpen(true);
                }
              }}>
        {label}
      </button>
      {open && <Menu anchor={button.current!} entries={entries()} onClose={() => setOpen(false)} />}
    </>
  );
}

/** A menu shown at a point, such as a context menu. */
export function ContextMenu({ x, y, entries, onClose }: { x: number; y: number; entries: MenuEntry[]; onClose: () => void }) {
  return <Menu point={{ x, y }} entries={entries} onClose={onClose} />;
}

function Menu({ anchor, point, entries, onClose }: {
  anchor?: HTMLElement;
  point?: { x: number; y: number };
  entries: MenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [focused, setFocused] = useState(-1);
  const items = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.kind === "item" && !entry.disabled);

  // Below the button if it fits, otherwise above it (like menus at the bottom of the window), kept on screen.
  useLayoutEffect(() => {
    const menu = ref.current!.getBoundingClientRect();
    const margin = 8;
    let left: number;
    let top: number;
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      left = rect.left;
      top = rect.bottom + 4;
      if (top + menu.height > window.innerHeight - margin) top = rect.top - 4 - menu.height;
    } else {
      left = point!.x;
      top = point!.y;
      if (top + menu.height > window.innerHeight - margin) top = point!.y - menu.height;
    }
    left = Math.min(Math.max(margin, left), window.innerWidth - menu.width - margin);
    top = Math.max(margin, top);
    setPosition({ left, top });
  }, [anchor, point]);

  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        anchor?.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const current = items.findIndex((i) => i.index === focused);
        const next = e.key === "ArrowDown" ? current + 1 : current - 1;
        setFocused(items[(next + items.length) % items.length]?.index ?? -1);
      } else if (e.key === "Enter") {
        const entry = entries[focused];
        if (entry?.kind === "item") {
          e.preventDefault();
          onClose();
          entry.action();
        }
      }
    };
    const close = () => onClose();
    document.addEventListener("mousedown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  });

  // Show a checkmark column only if some item can have one.
  const hasChecks = entries.some((e) => e.kind === "item" && e.checked !== undefined);

  return createPortal(
    <div ref={ref} className="menu" role="menu"
         style={position ? { left: position.left, top: position.top } : { visibility: "hidden", left: 0, top: 0 }}>
      {entries.map((entry, index) => {
        if (entry.kind === "separator") return <div key={index} className="menu-separator" role="separator" />;
        if (entry.kind === "section") return <div key={index} className="menu-section" style={hasChecks ? undefined : { paddingLeft: 10 }}>{entry.title}</div>;
        return (
          <button key={index} role="menuitemcheckbox" aria-checked={entry.checked ?? false}
                  className={`menu-item${focused === index ? " focused" : ""}`} disabled={entry.disabled}
                  onMouseEnter={() => setFocused(index)}
                  onClick={() => {
                    onClose();
                    entry.action();
                  }}>
            {hasChecks && <span className="check">{entry.checked && <Check size={12} strokeWidth={3} />}</span>}
            {entry.icon && <span className="icon">{entry.icon}</span>}
            <span>{entry.title}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
