/**
 * Branch colours.
 *
 * `PluginTheme` only exposes six tokens, none of which suit eight distinct branch lanes, so the
 * palette lives here. The variant is picked from the luminance of the panel background instead of
 * a theme flag, because plugins are not told whether the active theme is light or dark.
 */

const DARK_BACKGROUND_PALETTE = [
  "#4d9de0",
  "#f0803c",
  "#5cb85c",
  "#e05c7e",
  "#a78bfa",
  "#38bdf8",
  "#facc15",
  "#94a3b8",
];

const LIGHT_BACKGROUND_PALETTE = [
  "#1f6fb4",
  "#c25a12",
  "#2f8a33",
  "#c1385c",
  "#7c4dd0",
  "#0d8ab0",
  "#a17c07",
  "#5b6b7d",
];

function parseHex(color: string): [number, number, number] | null {
  const value = color.trim().replace(/^#/, "");
  if (value.length === 3) {
    const [r, g, b] = value.split("");
    return [
      Number.parseInt(`${r}${r}`, 16),
      Number.parseInt(`${g}${g}`, 16),
      Number.parseInt(`${b}${b}`, 16),
    ];
  }
  if (value.length === 6 || value.length === 8) {
    return [
      Number.parseInt(value.slice(0, 2), 16),
      Number.parseInt(value.slice(2, 4), 16),
      Number.parseInt(value.slice(4, 6), 16),
    ];
  }
  const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(color);
  if (match) {
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  return null;
}

export function isDarkBackground(background: string): boolean {
  const rgb = parseHex(background);
  if (!rgb) return true;
  const [r, g, b] = rgb;
  // Rec. 601 luma, good enough to choose between two hand-tuned palettes.
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

export function graphPalette(background: string): string[] {
  return isDarkBackground(background) ? DARK_BACKGROUND_PALETTE : LIGHT_BACKGROUND_PALETTE;
}

export function laneColor(palette: string[], colorIndex: number): string {
  return palette[colorIndex % palette.length]!;
}

/**
 * Theme colours are documented as strings but not as a specific notation, so alpha is only
 * appended when the value is a plain hex colour. Anything else falls back to `fallback` rather
 * than the opaque colour, which would swamp the text it sits behind.
 */
export function withAlpha(color: string, alpha: string, fallback = "transparent"): string {
  const value = color.trim();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? `${value}${alpha}` : fallback;
}


/** Git Graph tints changed files by what happened to them. */
const DARK_FILE_STATUS = {
  added: "#57a75a",
  modified: "#d8a657",
  deleted: "#e05252",
  renamed: "#5aa9e6",
  untracked: "#57a75a",
};

const LIGHT_FILE_STATUS = {
  added: "#2f7d32",
  modified: "#8a6100",
  deleted: "#c02626",
  renamed: "#1565c0",
  untracked: "#2f7d32",
};

export type FileStatusKind = keyof typeof DARK_FILE_STATUS;

/** Maps a `git status`/`git diff --raw` code to one of the five kinds above. */
export function fileStatusKind(status: string): FileStatusKind {
  const code = status.trim();
  if (code === "??" || code === "!!") return "untracked";
  if (code.startsWith("R") || code.startsWith("C")) return "renamed";
  if (code.startsWith("A")) return "added";
  if (code.startsWith("D") || code.endsWith("D")) return "deleted";
  return "modified";
}

export function fileStatusColor(status: string, background: string): string {
  const palette = isDarkBackground(background) ? DARK_FILE_STATUS : LIGHT_FILE_STATUS;
  return palette[fileStatusKind(status)];
}
