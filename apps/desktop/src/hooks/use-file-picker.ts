"use client";

import { useEffect, useRef, useState } from "react";
import { QueryClient, useMutation } from "@tanstack/react-query";

export function useFilePicker({ value, defaultValue = "", onValueChange, onBrowse }: {
  value?: string; defaultValue?: string; onValueChange?: (value: string) => void;
  onBrowse: (signal: AbortSignal) => Promise<string | null>;
}) {
  const [internal, setInternal] = useState(defaultValue);
  const [client] = useState(() => new QueryClient());
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const setValue = (next: string) => { setInternal(next); onValueChange?.(next); };
  const mutation = useMutation({
    retry: false, networkMode: "always", gcTime: 0,
    mutationFn: async (signal: AbortSignal) => {
      try {
        const path = await onBrowse(signal);
        return signal.aborted ? null : path;
      } catch (error) {
        if (signal.aborted) return null;
        throw error;
      } finally { if (controller.current?.signal === signal) controller.current = null; }
    },
    onSuccess: (path) => { if (path !== null) setValue(path); },
  }, client);
  return {
    value: value ?? internal, pending: mutation.isPending, error: mutation.error?.message,
    cancel: () => { controller.current?.abort(); mutation.reset(); },
    setValue: (next: string) => { mutation.reset(); setValue(next); },
    browse: () => {
      if (controller.current && !controller.current.signal.aborted) return;
      const current = new AbortController();
      controller.current = current;
      mutation.mutate(current.signal);
    },
  };
}
