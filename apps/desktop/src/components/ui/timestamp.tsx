"use client";

import { useSyncExternalStore } from "react";

const utc = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const local = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const subscribe = () => () => {};
export function Timestamp({ value, timeZone = "UTC" }: { value: string | null; timeZone?: "UTC" | "local" }) {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  const format = timeZone === "local" && hydrated ? local : utc;
  return value ? <time dateTime={value} title={value}>{format.format(new Date(value))}</time> : <span>Not recorded</span>;
}
