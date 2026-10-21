"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useRunnerCatalog } from "../hooks/use-runner-catalog";
import { useRunners } from "../hooks/use-runners";
import type { RunnerCatalog } from "../lib/runners";

const RunnerContext = createContext<(ReturnType<typeof useRunnerCatalog> & { status: ReturnType<typeof useRunners> }) | null>(null);
export function RunnerLiveProvider({ project, initial, children }: { project: string; initial?: RunnerCatalog; children: ReactNode }) {
  const catalog = useRunnerCatalog(project, initial), status = useRunners(project);
  return <RunnerContext.Provider value={{ ...catalog, status }}>{children}</RunnerContext.Provider>;
}
export function useRunnerLive() {
  const value = useContext(RunnerContext);
  if (!value) throw new Error("Runner status requires RunnerLiveProvider.");
  return value;
}
