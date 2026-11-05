import {
  AudioLines, Captions, ChevronRight, File, FileText, Folder, FolderOpen, FolderPlus, Pencil, RefreshCw,
  SquareArrowOutUpRight, Trash2, X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { backend, type LibraryEntry } from "../model/backend";
import type { Library } from "../model/library";
import { AUDIO_FILE_EXTENSIONS, parentFolder, relocatedPath, samePath } from "../model/TranscriptionModel";
import { ContextMenu, item, section, separator, type MenuEntry } from "./Menu";
import { NameField } from "./Pieces";

const nameOf = (path: string) => path.split(/[\\/]/).pop() ?? path;
const extensionOf = (name: string) => /\.([^.]*)$/.exec(name)?.[1]?.toLowerCase() ?? "";

/** Whether `entry` can be moved into `folder`: not where it already is, and not a folder into itself. */
function canMoveInto(entry: LibraryEntry, folder: string) {
  return !samePath(folder, parentFolder(entry.path)) && !samePath(folder, entry.path)
    && !folder.toLowerCase().startsWith(entry.path.toLowerCase() + "\\");
}

interface Drag {
  entry: LibraryEntry;
  x: number;
  y: number;
  /** The folder it would be moved into, or null where it can't be dropped. */
  target: string | null;
}

/**
 * The transcript folder, on the left of the window like the left page of an open book: make folders, rename,
 * delete (to the Recycle Bin), and move files and folders by dragging them onto a folder (or with Move To in the
 * context menu). Double-click opens a file.
 *
 * Dragging uses pointer events: the window takes file drops from Explorer, which turns off HTML drag and drop.
 */
export function Sidebar({ library, onClose }: { library: Library; onClose: () => void }) {
  const root = library.root;
  const [contents, setContents] = useState(new Map<string, LibraryEntry[]>());
  const [folders, setFolders] = useState<string[]>([]);
  const [rootError, setRootError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: LibraryEntry | null } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const pressed = useRef<{ entry: LibraryEntry; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);

  const reload = useCallback(async () => {
    if (!root) return;
    const listed = await Promise.all([root, ...expanded].map((folder) =>
      backend.listFolder(folder).then((entries) => [folder, entries] as const, (error) => {
        if (folder === root) setRootError(String(error));
        return null;
      })));
    if (listed[0]) setRootError(null);
    setContents(new Map(listed.filter((entry) => entry !== null)));
    setFolders(await backend.listSubfolders(root).catch(() => []));
  }, [root, expanded]);

  useEffect(() => void reload(), [reload, library.version]);

  // Pick up changes made in File Explorer.
  useEffect(() => {
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  const findEntry = (path: string) => {
    for (const entries of contents.values()) {
      const entry = entries.find((e) => samePath(e.path, path));
      if (entry) return entry;
    }
    return null;
  };

  /** Keeps expanded folders and the selection on an item that moved. */
  const follow = (from: string, to: string) => {
    setExpanded((paths) => new Set([...paths].map((p) => relocatedPath(p, from, to))));
    setSelected((path) => path && relocatedPath(path, from, to));
  };

  const toggle = (folder: string) => setExpanded((paths) => {
    const next = new Set(paths);
    if (!next.delete(folder)) next.add(folder);
    return next;
  });

  const rename = async (entry: LibraryEntry, name: string | null) => {
    setRenaming(null);
    if (name === null || !name.trim() || name.trim() === entry.name) return;
    const to = await library.rename(entry.path, name);
    if (to) follow(entry.path, to);
  };

  const move = async (entry: LibraryEntry, folder: string) => {
    const to = await library.move(entry.path, folder);
    if (!to) return;
    follow(entry.path, to);
    if (!samePath(folder, root)) setExpanded((paths) => new Set(paths).add(folder));
  };

  const newFolder = async (parent: string) => {
    const path = await library.createFolder(parent);
    if (!path) return;
    if (!samePath(parent, root)) setExpanded((paths) => new Set(paths).add(parent));
    setSelected(path);
    setRenaming(path);
  };

  const remove = async (entry: LibraryEntry) => {
    if (!(await library.remove(entry.path, entry.isFolder))) return;
    setExpanded((paths) => new Set([...paths].filter((p) => relocatedPath(p, entry.path, "") === p)));
    setSelected(null);
  };

  /** Where New Folder goes: into the selected folder, otherwise next to the selected file. */
  const newFolderParent = () => {
    const entry = selected ? findEntry(selected) : null;
    if (!entry) return root;
    return entry.isFolder ? entry.path : parentFolder(entry.path);
  };

  // Dragging: a press becomes a drag once the pointer moves a few pixels.
  const moveRef = useRef(move);
  moveRef.current = move;
  useEffect(() => {
    const update = (next: Drag | null) => {
      dragRef.current = next;
      setDrag(next);
    };
    const onMove = (e: PointerEvent) => {
      const press = pressed.current;
      if (!press || (!dragRef.current && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 5)) return;
      const element = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-drop-folder]");
      const folder = element?.dataset.dropFolder ?? null;
      update({ entry: press.entry, x: e.clientX, y: e.clientY, target: folder && canMoveInto(press.entry, folder) ? folder : null });
    };
    const onUp = () => {
      pressed.current = null;
      const current = dragRef.current;
      if (!current) return;
      update(null);
      // The click that ends a drag doesn't select or open anything.
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false));
      if (current.target) void moveRef.current(current.entry, current.target);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !dragRef.current) return;
      e.preventDefault();
      pressed.current = null;
      update(null);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);

  const relativeName = (folder: string) =>
    samePath(folder, root) ? nameOf(root) : folder.slice(root.length + 1).split("\\").join(" › ");

  const menuEntries = (entry: LibraryEntry | null): MenuEntry[] => {
    if (!entry) {
      return [
        item("New Folder", () => void newFolder(root), { icon: <FolderPlus size={13} /> }),
        item("Show in Explorer", () => void backend.openPath(root), { icon: <SquareArrowOutUpRight size={13} /> }),
        item("Refresh", () => void reload(), { icon: <RefreshCw size={13} /> }),
        separator,
        item("Choose Another Folder…", library.chooseFolder, { icon: <FolderOpen size={13} /> }),
      ];
    }
    const entries: MenuEntry[] = entry.isFolder
      ? [item("New Folder Inside", () => void newFolder(entry.path), { icon: <FolderPlus size={13} /> })]
      : [item("Open", () => void backend.openPath(entry.path), { icon: <SquareArrowOutUpRight size={13} /> })];
    entries.push(
      item("Rename", () => setRenaming(entry.path), { icon: <Pencil size={13} /> }),
      item("Show in Explorer", () => void backend.revealInExplorer(entry.path), { icon: <FolderOpen size={13} /> }),
      item("Move to Recycle Bin", () => void remove(entry), { icon: <Trash2 size={13} /> }),
    );
    const targets = [root, ...folders].filter((folder) => canMoveInto(entry, folder));
    if (targets.length > 0) {
      entries.push(separator, section("Move To"),
        ...targets.map((folder) => item(relativeName(folder), () => void move(entry, folder), { icon: <Folder size={13} /> })));
    }
    return entries;
  };

  const renderEntries = (folder: string, depth: number): React.ReactNode =>
    (contents.get(folder) ?? []).map((entry) => {
      const isOpen = entry.isFolder && expanded.has(entry.path);
      const isDropTarget = entry.isFolder && drag?.target !== null && drag?.target !== undefined && samePath(drag.target, entry.path);
      const isCurrent = library.currentPath !== null && samePath(library.currentPath, entry.path);
      const classes = ["library-row", selected && samePath(selected, entry.path) ? "selected" : "",
        isCurrent ? "current" : "", isDropTarget ? "drop-target" : "",
        drag && samePath(drag.entry.path, entry.path) ? "dragged" : ""].filter(Boolean).join(" ");
      return (
        <Fragment key={entry.path}>
          <div className={classes} style={{ paddingLeft: 6 + depth * 14 }} role="treeitem"
               aria-selected={selected !== null && samePath(selected, entry.path)}
               aria-expanded={entry.isFolder ? isOpen : undefined}
               // Dropping on a file moves into the folder it's in.
               data-drop-folder={entry.isFolder ? entry.path : folder}
               title={isCurrent ? `${entry.name} (the open transcript)` : entry.name}
               onPointerDown={(e) => {
                 if (e.button === 0 && renaming !== entry.path) pressed.current = { entry, x: e.clientX, y: e.clientY };
               }}
               onClick={() => {
                 if (suppressClick.current) return;
                 setSelected(entry.path);
                 if (entry.isFolder) toggle(entry.path);
               }}
               onDoubleClick={() => !entry.isFolder && void backend.openPath(entry.path)}
               onContextMenu={(e) => {
                 e.preventDefault();
                 e.stopPropagation();
                 setSelected(entry.path);
                 setMenu({ x: e.clientX, y: e.clientY, entry });
               }}>
            <span className={`library-chevron${isOpen ? " open" : ""}`}>
              {entry.isFolder && <ChevronRight size={11} strokeWidth={2.5} />}
            </span>
            <EntryIcon entry={entry} open={isOpen} />
            {renaming !== null && samePath(renaming, entry.path)
              ? <NameField className="library-rename" value={entry.name} selectStem={!entry.isFolder}
                           onDone={(name) => void rename(entry, name)} />
              : <span className="library-name">{entry.name}</span>}
          </div>
          {isOpen && renderEntries(entry.path, depth + 1)}
        </Fragment>
      );
    });

  const rootEntries = contents.get(root) ?? [];
  const rootIsTarget = drag?.target !== null && drag?.target !== undefined && samePath(drag.target, root);

  return (
    <aside className="sidebar" aria-label="Transcripts">
      <div className="sidebar-page">
        <div className="sidebar-header" data-tauri-drag-region>
          <div className="sidebar-title" data-tauri-drag-region>
            <strong>Transcripts</strong>
            <span title={root}>{nameOf(root)}</span>
          </div>
          <button className="toolbar-button" aria-label="New Folder" title="New folder"
                  onClick={() => void newFolder(newFolderParent())}>
            <FolderPlus size={15} />
          </button>
          <button className="toolbar-button" aria-label="Refresh" title="Refresh" onClick={() => void reload()}>
            <RefreshCw size={14} />
          </button>
          <button className="toolbar-button" aria-label="Close" title="Close (Ctrl+Shift+L)" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className={`library-tree${rootIsTarget ? " drop-target" : ""}`} role="tree" tabIndex={0} data-drop-folder={root}
             onClick={(e) => e.target === e.currentTarget && !suppressClick.current && setSelected(null)}
             onContextMenu={(e) => {
               e.preventDefault();
               setMenu({ x: e.clientX, y: e.clientY, entry: null });
             }}
             onKeyDown={(e) => {
               const entry = selected ? findEntry(selected) : null;
               // (A rename whose item has disappeared, say deleted in Explorer, doesn't count.)
               if (!entry || (renaming && findEntry(renaming))) return;
               if (e.key === "F2") {
                 e.preventDefault();
                 setRenaming(entry.path);
               } else if (e.key === "Delete") {
                 e.preventDefault();
                 void remove(entry);
               } else if (e.key === "Enter") {
                 e.preventDefault();
                 if (entry.isFolder) toggle(entry.path);
                 else void backend.openPath(entry.path);
               }
             }}>
          {renderEntries(root, 0)}
          {rootError && <p className="library-empty">Couldn't open the transcript folder: {rootError}</p>}
          {!rootError && rootEntries.length === 0 && (
            <p className="library-empty">No transcripts yet. They're saved here automatically.</p>
          )}
        </div>
        <div className="sidebar-footer caption">Drag files onto a folder to move them.</div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.entry)} onClose={() => setMenu(null)} />}
      {/* On the body: the sidebar's backdrop filter would otherwise position it relative to the sidebar. */}
      {drag && createPortal(
        <div className={`library-drag glass${drag.target ? "" : " no-drop"}`} style={{ left: drag.x + 14, top: drag.y + 10 }}>
          <EntryIcon entry={drag.entry} open={false} />
          <span>{drag.entry.name}</span>
        </div>,
        document.body,
      )}
    </aside>
  );
}

function EntryIcon({ entry, open }: { entry: LibraryEntry; open: boolean }) {
  if (entry.isFolder) return <span className="library-icon folder">{open ? <FolderOpen size={14} /> : <Folder size={14} />}</span>;
  const extension = extensionOf(entry.name);
  let icon = <File size={14} />;
  if (extension === "txt") icon = <FileText size={14} />;
  else if (["srt", "vtt", "fcpxml"].includes(extension)) icon = <Captions size={14} />;
  else if (AUDIO_FILE_EXTENSIONS.includes(extension)) icon = <AudioLines size={14} />;
  return <span className="library-icon">{icon}</span>;
}
