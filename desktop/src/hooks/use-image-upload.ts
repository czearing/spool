"use client";

import { useRef, useState } from "react";
import { isAgentImage } from "../lib/agent-settings";

async function readImage(file: File) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Choose a PNG, JPG or WebP image.");
  if (file.size > 5 * 1024 * 1024) throw new Error("Choose an image smaller than 5 MB.");
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error("This image could not be opened. Choose another image."); }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable in this browser.");
    const side = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
    const image = canvas.toDataURL("image/webp", 0.85);
    if (!isAgentImage(image)) throw new Error("This image is too detailed. Choose a smaller image.");
    return image;
  } finally { bitmap.close(); }
}
export function useImageUpload(onChange: (image: string | null) => void, onBusyChange?: (busy: boolean) => void) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const active = useRef(false);
  const upload = async (file?: File) => {
    if (!file || active.current) return;
    active.current = true; setBusy(true); setError(""); onBusyChange?.(true);
    try { onChange(await readImage(file)); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not upload the image."); }
    finally { active.current = false; setBusy(false); onBusyChange?.(false); }
  };
  return { busy, error, upload, remove: () => { setError(""); onChange(null); } };
}
