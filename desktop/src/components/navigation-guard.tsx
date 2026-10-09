"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "../platform/navigation";
import { Button } from "./ui/button";
import { Dialog, DialogClose } from "./ui/dialog";

const NavigationContext = createContext<{
  setDirty: (dirty: boolean) => void; navigate: (href: string) => void;
  registerFlush: (flush: () => Promise<boolean>) => () => void;
} | null>(null);
export function useNavigationGuard() {
  const guard = useContext(NavigationContext);
  if (!guard) throw new Error("Prompt navigation requires NavigationGuard.");
  return guard;
}
export function NavigationGuard({ children }: { children: ReactNode }) {
  const router = useRouter(), [dirty, setDirty] = useState(false), [destination, setDestination] = useState<string | null>(null);
  const flush = useRef<(() => Promise<boolean>) | null>(null);
  const registerFlush = useCallback((callback: () => Promise<boolean>) => {
    flush.current = callback; return () => { if (flush.current === callback) flush.current = null; };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return <NavigationContext.Provider value={{ setDirty, registerFlush, navigate: async (href) => {
    if (flush.current && !await flush.current()) setDestination(href);
    else if (dirty && !flush.current) setDestination(href);
    else router.push(href);
  } }}>
    {children}
    <Dialog open={destination !== null} onOpenChange={(open) => { if (!open) setDestination(null); }}
      title="Discard unsaved changes?" description="Your latest changes have not been saved. Keep editing or discard this draft."
      footer={<><DialogClose asChild><Button>Keep editing</Button></DialogClose>
        <Button variant="primary" onClick={() => {
          if (destination) { setDirty(false); router.push(destination); setDestination(null); }
        }}>Discard changes</Button></>} />
  </NavigationContext.Provider>;
}
