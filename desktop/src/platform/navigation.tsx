import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

const Refresh = createContext<() => void>(() => {});
const Location = createContext<string | undefined>(undefined);
const Pathname = createContext<string | undefined>(undefined);
const Prefetch = createContext<(href: string) => void>(() => {});
const changed = () => window.dispatchEvent(new PopStateEvent("popstate"));
const location = () => window.location.hash.slice(1) || "/";
const subscribe = (notify: () => void) => {
  window.addEventListener("popstate", notify);
  window.addEventListener("hashchange", notify);
  return () => { window.removeEventListener("popstate", notify); window.removeEventListener("hashchange", notify); };
};
const scopedSubscribe = () => () => {};
export function useLocation() {
  const scoped = useContext(Location);
  return useSyncExternalStore(scoped === undefined ? subscribe : scopedSubscribe,
    () => scoped ?? location(), () => scoped ?? "/");
}
export function getPathname() { return location().split("?")[0]; }
export function usePathname() {
  const scoped = useContext(Pathname);
  return useSyncExternalStore(scoped === undefined ? subscribe : scopedSubscribe,
    () => scoped ?? getPathname(), () => scoped ?? "/");
}
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
export function useNavigationPrefetch(href: string) {
  const prefetch = useContext(Prefetch), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = useCallback(() => { clearTimeout(timer.current); timer.current = undefined; }, []);
  useEffect(() => cancel, [href, cancel]);
  return {
    start: () => { cancel(); timer.current = setTimeout(() => prefetch(href), 120); },
    cancel, run: () => { cancel(); prefetch(href); },
  };
}
export function NavigationProvider({ refresh, location, prefetch, children }: {
  refresh: () => void; location?: string; prefetch?: (href: string) => void; children: ReactNode;
}) {
  const inheritedPrefetch = useContext(Prefetch);
  return <Prefetch.Provider value={prefetch ?? inheritedPrefetch}><Location.Provider value={location}><Pathname.Provider value={location?.split("?")[0]}>
    <Refresh.Provider value={refresh}>{children}</Refresh.Provider>
  </Pathname.Provider></Location.Provider></Prefetch.Provider>;
}
export function NavigationSnapshot({ active, refresh, children }: { active: boolean; refresh: () => void; children: ReactNode }) {
  // Hidden projects must not follow another project's route or conversation selection.
  const location = useLocation(), [saved, setSaved] = useState(location);
  if (active && saved !== location) setSaved(location);
  return <NavigationProvider location={active ? location : saved} refresh={refresh}>{children}</NavigationProvider>;
}
