"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useRunners } from "../hooks/use-runners";

const RunnerContext = createContext<ReturnType<typeof useRunners> | null>(null);
export function RunnerLiveProvider({ project, children }: { project: string; children: ReactNode }) {
  const value = useRunners(project);
  return <RunnerContext.Provider value={value}>{children}</RunnerContext.Provider>;
}
export function useRunnerLive() {
  const value = useContext(RunnerContext);
  if (!value) throw new Error("Runner status requires RunnerLiveProvider.");
  return value;
}
