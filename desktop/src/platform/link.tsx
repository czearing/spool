import type { ComponentPropsWithRef } from "react";
import { navigate } from "./navigation";

type Props = ComponentPropsWithRef<"a"> & {
  href: string; prefetch?: boolean; onNavigate?: (event: { preventDefault: () => void }) => void;
};
export default function Link({ href, prefetch: _prefetch, onNavigate, onClick, ...props }: Props) {
  return <a {...props} href={`#${href}`} onClick={event => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    let prevented = false;
    onNavigate?.({ preventDefault: () => { prevented = true; } });
    if (!prevented) navigate(href);
  }} />;
}
