"use client";

import { appFetch } from "../platform/request";


import { useState } from "react";
import { QueryClient, useMutation } from "@tanstack/react-query";

export function useCreateProject(onCreated: (id: string) => void) {
  const [client] = useState(() => new QueryClient());
  return useMutation({
    retry: false,
    mutationFn: async (input: { name: string; root: string }) => {
      const response = await appFetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const message = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error : "Could not create the project. Try again.";
        throw new Error(message);
      }
      if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string") {
        throw new Error("The server returned an invalid project.");
      }
      return result.id;
    },
    onSuccess: onCreated,
  }, client);
}
