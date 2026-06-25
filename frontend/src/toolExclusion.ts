/**
 * Mutual exclusion for the page "tools" (Highlight, Explain, Erase).
 *
 * Each tool registers a disabler under a name. When one tool activates it
 * calls `deactivateOthers(name)` to switch the rest off — two click/drag
 * cursors over the page at once would be confusing. Kept in its own module so
 * the tool modules don't import each other (which would be circular).
 */

type Disabler = () => void;

const tools = new Map<string, Disabler>();

export function registerTool(name: string, disable: Disabler): void {
  tools.set(name, disable);
}

export function deactivateOthers(except: string): void {
  for (const [name, disable] of tools) {
    if (name !== except) disable();
  }
}

/** For tests. */
export function _resetForTest(): void {
  tools.clear();
}
