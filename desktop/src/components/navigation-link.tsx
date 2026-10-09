"use client";

import Link from "../platform/link";
import type { ComponentPropsWithRef } from "react";
import { useNavigationGuard } from "./navigation-guard";

export function NavigationLink(props: ComponentPropsWithRef<"a"> & { href: string }) {
  const { navigate } = useNavigationGuard();
  return <Link {...props} prefetch={true} onNavigate={(event) => { event.preventDefault(); navigate(props.href); }} />;
}
