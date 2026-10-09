import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

const Refresh = createContext<() => void>(() => {});
const changed = () => window.dispatchEvent(new PopStateEvent("popstate"));
const location = () => window.location.hash.slice(1) || "/";
const subscribe = (notify: () => void) => {
  window.addEventListener("popstate", notify);
  window.addEventListener("hashchange", notify);
  return () => { window.removeEventListener("popstate", notify); window.removeEventListener("hashchange", notify); };
};
export function useLocation() { return useSyncExternalStore(subscribe, location, () => "/"); }
export function usePathname() { return useLocation().split("?")[0]; }
export function useSearchParams() {
  const value = useLocation();
  return useMemo(() => new URLSearchParams(value.split("?")[1] || ""), [value]);
}
export function navigate(href: string, replace = false) {
  if (!href.startsWith("/") || href.startsWith("//")) throw new Error("Only local app navigation is supported.");
  window.history[replace ? "replaceState" : "pushState"](null, "", `#${href}`);
  changed();
}
export function useRouter() {
  const refresh = useContext(Refresh);
  const push = useCallback((href: string) => navigate(href), []);
  const replace = useCallback((href: string) => navigate(href, true), []);
  return useMemo(() => ({ push, replace, refresh, back: () => history.back() }), [push, replace, refresh]);
}
export function NavigationProvider({ refresh, children }: { refresh: () => void; children: ReactNode }) {
  return <Refresh.Provider value={refresh}>{children}</Refresh.Provider>;
}
