/**
 * Shared fixture wiring for the tests. No production path reads this file.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export const fixtureRepo = resolve(here, "fixtures", "repo");

/** A small repository whose documents and comments state commands, some of which do not resolve. */
export const commandsFixture = resolve(here, "fixtures", "commands");

/** A repository whose worst reader cost is in source comments rather than in any markdown document. */
export const sourceOnlyFixture = resolve(here, "fixtures", "source-only");

export const apiTrees = ["packages/api", "packages/docs"];

export const apiReaders = [
  {
    id: "api-consumer",
    match: "^packages/api/",
    reader: "an engineer calling the api client",
    job: "call the client with the right options",
  },
  {
    id: "docs-reader",
    match: "^packages/docs/",
    reader: "an engineer reading package documentation",
    job: "read the package notes",
  },
];

export const trees = ["apps/new-office", "packages/new-office-ux", "packages/new-office-proxy"];

export const readers = [
  {
    id: "new-office-app",
    match: "^apps/new-office/",
    reader: "an engineer changing the new office application shell",
    job: "find the entry point named here and change it",
  },
  {
    id: "new-office-ux",
    match: "^packages/new-office-ux/",
    reader: "an engineer consuming a new office ux component",
    job: "call the component with the right arguments",
  },
];
