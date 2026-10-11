export type Category = keyof typeof CATEGORIES;

/// The committed title prefixes. Held as data so a title can only ever be assembled,
/// never typed, which is what makes the format unbreakable.
export const CATEGORIES = {
  feat: { emoji: "✨", label: "Feat" },
  fix: { emoji: "🐛", label: "Fix" },
  docs: { emoji: "📝", label: "Docs" },
  deps: { emoji: "📦", label: "Deps" },
  perf: { emoji: "⚡", label: "Perf" },
  tests: { emoji: "🧪", label: "Tests" },
  ci: { emoji: "🔧", label: "CI" },
  refactor: { emoji: "♻️", label: "Refactor" },
} as const;

export const CATEGORY_IDS = Object.keys(CATEGORIES) as Category[];

export const MAX_TITLE_WORDS = 6;

export function buildTitle(category: Category, title: string): string {
  const { emoji, label } = CATEGORIES[category];
  return `${emoji} ${label} - ${title.trim()}`;
}

/// Recovers the category from a stored title so an update can revalidate the whole
/// pull request instead of only the fields it was handed.
export function parseTitle(stored: string): { category?: Category; title: string } {
  for (const id of CATEGORY_IDS) {
    const { emoji, label } = CATEGORIES[id];
    const prefix = `${emoji} ${label} - `;
    if (stored.startsWith(prefix)) return { category: id, title: stored.slice(prefix.length) };
  }
  return { title: stored };
}
