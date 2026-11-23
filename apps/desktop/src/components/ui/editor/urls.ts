export function safeEditorUrl(value: string, image = false): boolean {
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) return false;
  if (/^\/(?!\/)/.test(value) || (!image && value.startsWith("#"))) return true;
  try {
    const { protocol } = new URL(value);
    return (image ? ["http:", "https:"] : ["http:", "https:", "mailto:", "tel:"]).includes(protocol);
  } catch { return false; }
}
