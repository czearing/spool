import { themes, type Theme } from "./theme";

export type Settings = { theme: Theme };
export const settingsKey = "spool:settings";
export const defaultSettings: Settings = { theme: "light" };
export const validModel = (value: unknown): value is string =>
  typeof value === "string" && (value === "" || /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value));

export function parseSettings(raw: string | null): Settings {
  if (raw === null) return defaultSettings;
  const value: unknown = JSON.parse(raw);
  const theme = value && typeof value === "object" && "theme" in value ? themes.find((theme) => theme === value.theme) : undefined;
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
    !theme) throw new Error("Invalid saved settings.");
  return { theme };
}

export const themeBootstrap = `try{var s=JSON.parse(localStorage.getItem(${JSON.stringify(settingsKey)})||"null");
if(s&&s.version===1&&${JSON.stringify(themes)}.includes(s.theme))document.documentElement.setAttribute("data-theme",s.theme);
}catch(e){console.warn("Unable to restore saved theme.",e)}`;
