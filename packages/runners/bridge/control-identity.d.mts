export function digest(value: import("node:crypto").BinaryLike): string;
export function commandIdentity(key: string): string;
export function recoveryCommandId(
  task: { id: string; updated_at?: string; session_id?: string | null },
  message?: { id: string },
  startup?: boolean,
): string;
