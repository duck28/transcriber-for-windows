// The transcript folder as the sidebar sees it. The model owns it: changes run between auto-saves and keep the
// open transcript's file in step.

export interface Library {
  /** The transcript folder. */
  root: string;
  /** The open transcript's file, if it has been saved. */
  currentPath: string | null;
  /** Changes whenever the folder was changed from the app, so it gets listed again. */
  version: number;
  /** Creates "New Folder" in `parent`; returns its path, or null if that failed. */
  createFolder(parent: string): Promise<string | null>;
  /** Returns the new path, or null if renaming failed. */
  rename(path: string, name: string): Promise<string | null>;
  /** Moves into `folder`; returns the new path, or null if moving failed. */
  move(path: string, folder: string): Promise<string | null>;
  /** Asks first, then moves the item to the Recycle Bin; returns whether it was deleted. */
  remove(path: string, isFolder: boolean): Promise<boolean>;
  chooseFolder(): void;
}
