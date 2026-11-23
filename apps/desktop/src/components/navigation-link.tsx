"use client";

import Link from "../platform/link";
import type { ComponentPropsWithRef } from "react";
import { useNavigationGuard } from "./navigation-guard";
import { restoreAgentLocation } from "../platform/navigation";

export function NavigationLink(props: ComponentPropsWithRef<"a"> & { href: string }) {
  const { navigate } = useNavigationGuard();
  return <Link {...props} href={restoreAgentLocation(props.href)} prefetch={true}
    onNavigate={(event) => { event.preventDefault(); navigate(restoreAgentLocation(props.href)); }} />;
}
