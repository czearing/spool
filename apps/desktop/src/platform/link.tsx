import type { ComponentPropsWithRef } from "react";
import { navigate, useNavigationPrefetch } from "./navigation";

type Props = ComponentPropsWithRef<"a"> & {
  href: string; prefetch?: boolean; onNavigate?: (event: { preventDefault: () => void }) => void;
};
export default function Link({ href, prefetch, onNavigate, onClick, onPointerEnter, onPointerLeave, onFocus, ...props }: Props) {
  const intent = useNavigationPrefetch(href);
  return <a {...props} href={`#${href}`}
    onPointerEnter={event => { onPointerEnter?.(event); if (prefetch && !event.defaultPrevented) intent.start(); }}
    onPointerLeave={event => { onPointerLeave?.(event); intent.cancel(); }}
    onFocus={event => { onFocus?.(event); if (prefetch && !event.defaultPrevented) intent.run(); }}
    onClick={event => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    let prevented = false;
    onNavigate?.({ preventDefault: () => { prevented = true; } });
    if (!prevented) navigate(href);
  }} />;
}
