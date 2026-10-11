import { createExclusionRules } from "../lib/exclusion.mjs";

export { segments } from "../lib/exclusion.mjs";
export const { exclusionReason, isExcluded, partition } = createExclusionRules({
  filenames: ["newofficestrings.ts", "newofficestrings.json"],
  segmentWords: ["stringtypes", "translations", "locales", "i18n", "__generated__", "generated", "__mocks__", "fixtures"],
  suffixes: [".generated.ts", ".generated.tsx", ".generated.js", ".generated.jsx",
    ".g.ts", ".g.tsx", ".g.js", "strings.ts", "strings.json"],
});
