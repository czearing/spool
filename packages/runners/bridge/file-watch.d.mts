type WatchTarget = {
  path: string; directory?: boolean;
  accepts?: (file: string, event: string) => boolean;
};
export function watchFiles(
  targets: () => WatchTarget[],
  changed: () => void,
  failed: (error: Error) => void,
  options?: { persistent?: boolean },
): { sync: () => void; close: () => void };
