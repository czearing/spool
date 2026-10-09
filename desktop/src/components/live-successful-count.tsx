"use client";

import { useProjectLive } from "./project-live-provider";

export function LiveSuccessfulCount({ initial }: { initial: number }) {
  const { data } = useProjectLive();
  return (data?.successful ?? initial).toLocaleString("en-US");
}
