export interface PanelProps {
  panelId: string;
}

export const PanelToolbar = "toolbar";

export function createPanel(panelId: string): string {
  return panelId;
}

export function usePanelState(panelId: string): string {
  return panelId;
}

/**
 * Opens the panel.
 * @param panelId the panel to open
 * @param legacyFlag removed a while ago
 */
export function openPanel(panelId: string): void {}

/**
 * @returns the panel that was closed
 */
export function closePanel(panelId: string): void {}

/**
 * @param panelId the panel to render
 */
export function renderPanel(panelId: string): string {
  return panelId;
}
