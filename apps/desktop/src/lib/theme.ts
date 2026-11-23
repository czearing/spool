export const themes = ["system", "light", "dark"] as const;
export type Theme = (typeof themes)[number];

export function parseTheme(value: unknown): Theme {
  const theme = themes.find((theme) => theme === value);
  if (theme) return theme;
  if (value !== null && value !== undefined) console.warn("Ignoring an invalid preview theme.");
  return "system";
}

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
}
