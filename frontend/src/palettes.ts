/**
 * Highlight color palettes. Each palette is a named set of hex colors the user
 * can pick from; the chosen palette + color are persisted as the reader's
 * default. The "Explain" highlight (AI feature) is a separate, fixed color and
 * is NOT part of these cosmetic palettes.
 */

export interface Palette {
  id: string;
  name: string;
  colors: string[]; // hex "#RRGGBB"
}

export const PALETTES: Palette[] = [
  {
    id: "classic",
    name: "Classic",
    colors: ["#FFEB3B", "#4CAF50", "#F44336", "#E91E63", "#FF9800"],
  },
  {
    id: "pastel",
    name: "Pastel",
    colors: ["#FFF59D", "#C8E6C9", "#FFCDD2", "#F8BBD0", "#BBDEFB"],
  },
  {
    id: "vibrant",
    name: "Vibrant",
    colors: ["#FFEA00", "#00E676", "#FF1744", "#F500A0", "#00B0FF"],
  },
  {
    id: "earthy",
    name: "Earthy",
    colors: ["#E6D8AD", "#B5A642", "#C1876B", "#8FA37E", "#A88B6A"],
  },
];

/** The dedicated AI "Explain" highlight color (kept recognizably blue). */
export const EXPLAIN_COLOR = "#2196F3";

export const DEFAULT_PALETTE_ID = PALETTES[0].id;
export const DEFAULT_COLOR = PALETTES[0].colors[0];

export function paletteById(id: string): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}

export interface HighlightPrefs {
  paletteId: string;
  color: string;
}

const PREFS_KEY = "scai.highlightPrefs";

export function loadHighlightPrefs(): HighlightPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (typeof o?.paletteId === "string" && typeof o?.color === "string") {
        return { paletteId: o.paletteId, color: o.color };
      }
    }
  } catch {
    /* ignore */
  }
  return { paletteId: DEFAULT_PALETTE_ID, color: DEFAULT_COLOR };
}

export function saveHighlightPrefs(prefs: HighlightPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}
