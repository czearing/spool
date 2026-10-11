/**
 * Presentation helpers for the dashboard.
 *
 * Split from the page itself so both stay small and the escaping rule has one home. Every value
 * shown on this page came from a branch name, a reviewer's comment or an agent's transcript, so
 * all of it is treated as untrusted text. No regular expressions are used.
 */

/** Escape text for HTML. A branch or reviewer name is attacker-adjacent input; treat it as data. */
export function escapeHtml(value) {
  return String(value ?? "")
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;")
    .split('"').join("&quot;");
}

export function duration(ms) {
  if (!Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function when(at) {
  const parsed = Date.parse(at || "");
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : "";
}

/** The per-step bar, so a slow job points at its own cause without opening the log. */
export function stepsCell(steps) {
  // `stepTimings` records an object keyed by step name, already ordered slowest first, with the
  // total in front. The total has its own column, so only the named steps are shown here.
  if (!steps || typeof steps !== "object") return "";
  return Object.entries(steps)
    .filter(([name, ms]) => name !== "totalMs" && Number.isFinite(ms))
    .map(([name, ms]) => `<span class="step">${escapeHtml(name)} ${escapeHtml(duration(ms))}</span>`)
    .join(" ");
}

export const STYLES = `
  :root { color-scheme: light dark; }
  body { font: 13px/1.5 "Segoe UI", system-ui, sans-serif; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; margin: 22px 0 6px; }
  .headline { font-size: 15px; margin-bottom: 16px; }
  .ok { color: #107c10; } .bad { color: #c50f1f; } .empty { color: #8a8886; }
  .warn { color: #ca5010; font-weight: 600; opacity: 1; }
  .holding { color: #0078d4; }
  .outage { background: #c50f1f; color: #fff; padding: 14px 16px; border-radius: 6px; margin-bottom: 16px; font-size: 15px; }
  .outage .muted { opacity: .85; font-family: ui-monospace, Consolas, monospace; font-size: 12px; margin-top: 6px; }
  .outage .remedy { margin-top: 8px; }
  .outage code { background: rgba(0,0,0,.28); padding: 3px 7px; border-radius: 4px; user-select: all; }
  .muted { opacity: .6; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid rgba(128,128,128,.3); vertical-align: top; }
  th { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .ago { white-space: nowrap; opacity: .7; }
  .tag { border-radius: 3px; padding: 1px 6px; font-size: 11px; background: rgba(128,128,128,.18); }
  .t-conflict { background: rgba(197,15,31,.18); }
  .t-build { background: rgba(202,80,16,.18); }
  .t-review { background: rgba(0,120,212,.18); }
  .t-agency { background: rgba(215,83,203,.18); }
  .b-passed { color: #107c10; } .b-failed, .b-blocked { color: #c50f1f; }
  .b-running { color: #ca5010; } .b-none { opacity: .55; }
  tr.ready td { background: rgba(16,124,16,.12); }
  tr.held-agent td { background: rgba(120,60,220,.13); }
  tr.held-script td { background: rgba(202,80,16,.11); }
  tr.held td:first-child { border-left: 3px solid transparent; }
  tr.held-agent td:first-child { border-left-color: #7a3cdc; }
  tr.held-script td:first-child { border-left-color: #ca5010; }
  .own { border-radius: 3px; padding: 1px 7px; font-size: 11px; font-weight: 600; white-space: nowrap; }
  .own-agent { background: rgba(120,60,220,.22); color: #6b30c8; }
  .own-script { background: rgba(202,80,16,.22); color: #b04a0e; }
  .ready-flag { color: #107c10; font-weight: 600; white-space: nowrap; }
  .step { font-size: 11px; opacity: .75; white-space: nowrap; }
  .s-failed td { background: rgba(197,15,31,.07); }
  .ev { border-bottom: 1px solid rgba(128,128,128,.22); padding: 5px 0; }
  .ev.flat { display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; padding-left: 15px; }
  .ev.s-failed { background: rgba(197,15,31,.07); }
  .who { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; flex: 0 0 46px; opacity: .8; }
  .who-agent { color: #6b30c8; }
  .who-script { color: #b04a0e; }
  .repeat { font-size: 11px; opacity: .7; font-variant-numeric: tabular-nums; }
  summary { cursor: pointer; display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; }
  summary .ago, .ev.flat .ago { flex: 0 0 132px; }
  .metrics { display: flex; gap: 18px; flex-wrap: wrap; margin: 8px 0 6px 18px; }
  .metrics div { font-size: 12px; }
  .metrics span { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
  pre.log { margin: 6px 0 10px 18px; padding: 10px; max-height: 320px; overflow: auto; white-space: pre-wrap;
    background: rgba(128,128,128,.12); border-radius: 4px; font: 12px/1.45 Consolas, monospace; }
  footer { margin-top: 18px; font-size: 11px; opacity: .6; }
`;
