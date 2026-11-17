export function waitForMessageReceipt<T>(file: string, confirm: () => T | Promise<T>): Promise<T>;
