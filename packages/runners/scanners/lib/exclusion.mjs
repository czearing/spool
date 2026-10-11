const AGENT_FILENAMES = ["agents.md", "claude.md", "skill.md"];
const GITHUB_DIRECTORIES = new Set(["skills", "prompts", "agents", "instructions"]);
const AGENT_WORDS = ["agent", "copilot", "prompt"];

export function segments(value) {
  return String(value).replace(/\\/g, "/").split("/").filter(Boolean);
}

export function createExclusionRules({ filenames = [], segmentWords = [], suffixes = [] } = {}) {
  const excludedFilenames = new Set([...AGENT_FILENAMES, ...filenames]);
  const excludedWords = [...AGENT_WORDS, ...segmentWords];
  function exclusionReason(value) {
    const parts = segments(value);
    if (!parts.length) return "empty path";
    const filename = parts.at(-1).toLowerCase();
    if (excludedFilenames.has(filename)) return `excluded filename ${filename}`;
    for (const suffix of suffixes) {
      if (filename.endsWith(suffix)) return `excluded generated file suffix ${suffix}`;
    }
    for (let index = 0; index < parts.length - 1; index++) {
      if (parts[index].toLowerCase() === ".github" && GITHUB_DIRECTORIES.has(parts[index + 1].toLowerCase())) {
        return `excluded directory .github/${parts[index + 1].toLowerCase()}`;
      }
    }
    for (const part of parts) {
      for (const word of excludedWords) {
        if (part.toLowerCase().includes(word)) return `excluded path segment contains ${word}`;
      }
    }
    return null;
  }
  function partition(paths) {
    const kept = [], skipped = [];
    for (const value of paths) {
      const reason = exclusionReason(value);
      if (reason === null) kept.push(value);
      else skipped.push({ path: value, reason });
    }
    return { kept, skipped };
  }
  return { exclusionReason, isExcluded: value => exclusionReason(value) !== null, partition };
}
