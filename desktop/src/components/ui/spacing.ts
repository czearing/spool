export type Space = 0 | 1 | 2 | 3 | 4 | 6 | 8;
export const space = (value: Space) => `var(--space-${value})`;
