import { isAbsolute } from "node:path";

export type ApplicationPaths = Readonly<{ data: string; resources: string }>;
let paths: ApplicationPaths | undefined;

export function configureApplication(input: ApplicationPaths) {
  if (!isAbsolute(input.data) || !isAbsolute(input.resources)) {
    throw new Error("Application data and resources must be absolute directories.");
  }
  paths = Object.freeze({ ...input });
}

export function applicationPaths(): ApplicationPaths {
  if (!paths) throw new Error("Application paths have not been configured.");
  return paths;
}
