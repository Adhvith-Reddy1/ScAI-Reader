/**
 * Highlight color palettes. The Highlight popover shows the current palette's
 * swatches; a ⋮ menu switches palettes. The Explain button reuses whichever
 * palette is currently selected. Chosen palette + colors persist as defaults.
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
    colors: ["#FFEB3B", "#2196F3", "#4CAF50", "#E91E63", "#F44336"],
  },
  {
    id: "pastel",
    name: "Pastel",
    colors: ["#FFF59D", "#BBDEFB", "#C8E6C9", "#F8BBD0", "#FFCDD2"],
  },
  {
    id: "vibrant",
    name: "Vibrant",
    colors: ["#FFEA00", "#00B0FF", "#00E676", "#F500A0", "#FF1744"],
  },
  {
    id: "earthy",
    name: "Earthy",
    colors: ["#E6D8AD", "#8FA37E", "#B5A642", "#C1876B", "#A88B6A"],
  },
];

export const DEFAULT_PALETTE_ID = PALETTES[0].id;
export const DEFAULT_COLOR = PALETTES[0].colors[0]; // yellow
export const DEFAULT_EXPLAIN_COLOR = PALETTES[0].colors[1]; // blue

export function paletteById(id: string): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}

export interface HighlightPrefs {
  paletteId: string;
  color: string; // last cosmetic color (Highlight default)
  explainColor: string; // last Explain color
}

const PREFS_KEY = "scai.highlightPrefs";

export function loadHighlightPrefs(): HighlightPrefs {
  const base: HighlightPrefs = {
    paletteId: DEFAULT_PALETTE_ID,
    color: DEFAULT_COLOR,
    explainColor: DEFAULT_EXPLAIN_COLOR,
  };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (typeof o?.paletteId === "string") base.paletteId = o.paletteId;
      if (typeof o?.color === "string") base.color = o.color;
      if (typeof o?.explainColor === "string") base.explainColor = o.explainColor;
    }
  } catch {
    /* ignore */
  }
  return base;
}

/** Merge a partial update into the saved prefs. */
export function saveHighlightPrefs(patch: Partial<HighlightPrefs>): void {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ ...loadHighlightPrefs(), ...patch }),
    );
  } catch {
    /* ignore */
  }
}
