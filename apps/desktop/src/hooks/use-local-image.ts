import { useEffect, useState } from "react";
import { appFetch } from "../platform/request";
import { isTauri } from "@tauri-apps/api/core";

export function useLocalImage(url?: string) {
  const [image, setImage] = useState<{ url: string; src: string }>();
  useEffect(() => {
    if (!url || !isTauri()) return;
    const controller = new AbortController();
    let src: string | undefined;
    void appFetch(url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Agent image could not be read.");
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      src = URL.createObjectURL(blob); setImage({ url, src });
    }).catch(error => { if (!controller.signal.aborted) console.error("Unable to load agent image.", error); });
    return () => { controller.abort(); if (src) URL.revokeObjectURL(src); };
  }, [url]);
  return isTauri() ? image && image.url === url ? image.src : undefined : url;
}
