"use client";

import { appFetch } from "../platform/request";


import { useMutation, useQueryClient } from "@tanstack/react-query";

export function useCreateProject(onCreated: (id: string) => void) {
  const client = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async (input: { name: string }) => {
      const response = await appFetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const message = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error : "Could not add the project. Try again.";
        throw new Error(message);
      }
      if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string") {
        throw new Error("The server returned an invalid project.");
      }
      return result.id;
    },
    onSuccess: id => {
      void client.invalidateQueries({ queryKey: ["desktop-page"] });
      onCreated(id);
    },
  });
}
