"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { defaultSettings, parseSettings, settingsKey, type Settings } from "../lib/settings";
import { applyTheme } from "../lib/theme";

type State = { settings: Settings; ready: boolean; error?: string; update: (patch: Partial<Settings>) => boolean };
const Context = createContext<State | null>(null);
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(defaultSettings), [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const restore = () => {
      try {
        const saved = parseSettings(localStorage.getItem(settingsKey));
        setSettings(saved); applyTheme(saved.theme); setError(undefined);
      } catch (cause) {
        console.error("Unable to restore settings.", cause);
        setError("Saved settings could not be read. Choose your preferences again to replace them.");
      }
      setReady(true);
    };
    const changed = (event: StorageEvent) => { if (event.key === settingsKey || event.key === null) restore(); };
    restore(); window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const update = (patch: Partial<Settings>) => {
    try {
      const next = parseSettings(JSON.stringify({ version: 1, ...settings, ...patch }));
      localStorage.setItem(settingsKey, JSON.stringify({ version: 1, ...next }));
      setSettings(next); applyTheme(next.theme); setError(undefined);
      return true;
    } catch (cause) {
      console.error("Unable to save settings.", cause);
      setError("Settings could not be saved. Allow local storage and try again.");
      return false;
    }
  };
  return <Context.Provider value={{ settings, ready, error, update }}>{children}</Context.Provider>;
}
export function useSettings() {
  const state = useContext(Context);
  if (!state) throw new Error("SettingsProvider is required.");
  return state;
}
