"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "../platform/navigation";
import { useProjectLive } from "./project-live-provider";

export function LiveQueueRefresh({ initialVersion }: { initialVersion: string }) {
  const { data } = useProjectLive(), router = useRouter(), previous = useRef(initialVersion);
  useEffect(() => {
    if (!data) return;
    if (previous.current && previous.current !== data.boardVersion) router.refresh();
    previous.current = data.boardVersion;
  }, [data, router]);
  return null;
}
