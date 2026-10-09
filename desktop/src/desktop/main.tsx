import { createRoot } from "react-dom/client";
import { SettingsProvider } from "../components/settings-provider";
import { parseSettings, settingsKey } from "../lib/settings";
import { applyTheme } from "../lib/theme";
import { DesktopApp } from "./app";
import "../app/globals.css";

try { applyTheme(parseSettings(localStorage.getItem(settingsKey)).theme); }
catch (error) { console.error("Unable to restore saved theme.", error); }
createRoot(document.getElementById("root")!).render(<SettingsProvider><DesktopApp /></SettingsProvider>);
