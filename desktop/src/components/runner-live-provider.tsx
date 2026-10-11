"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useRunners } from "../hooks/use-runners";
import type { RunnerCatalog } from "../lib/runner-catalog";

const RunnerContext = createContext<ReturnType<typeof useRunners> | null>(null);
export function RunnerLiveProvider({ project, initial, children }: { project: string; initial?: RunnerCatalog; children: ReactNode }) {
  const value = useRunners(project, initial);
  return <RunnerContext.Provider value={value}>{children}</RunnerContext.Provider>;
}
export function useRunnerLive() {
  const value = useContext(RunnerContext);
  if (!value) throw new Error("Runner status requires RunnerLiveProvider.");
  return value;
}
