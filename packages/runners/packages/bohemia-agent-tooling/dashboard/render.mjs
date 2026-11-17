export function renderDashboard(data) {
const dataJson = JSON.stringify(data).replace(/</g, "\\u003c");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Azure DevOps | Bohemia Gate & PR Automation</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect width=%22100%22 height=%22100%22 rx=%2220%22 fill=%22%230078d4%22/><path d=%22M25 50 L42 67 L75 33%22 fill=%22none%22 stroke=%22white%22 stroke-width=%2212%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/></svg>">
  <style>
    :root {
      --ado-blue: #0078d4;
      --ado-blue-dark: #005a9e;
      --ado-blue-light: #e5f1fb;
      --ado-nav-bg: #1f1f1f;
      --ado-header-bg: #ffffff;
      --ado-bg: #f8f9fa;
      --ado-card-bg: #ffffff;
      --ado-border: #e1dfdd;
      --ado-text: #242424;
      --ado-text-secondary: #605e5c;
      --ado-text-muted: #8a8886;
      --ado-green: #107c10;
      --ado-green-bg: #dff6dd;
      --ado-red: #d13438;
      --ado-red-bg: #fde7e9;
      --ado-orange: #d83b01;
      --ado-orange-bg: #fed9cc;
      --ado-purple: #5c2d91;
      --ado-purple-bg: #f1e9f7;
      --ado-teal: #008272;
      --ado-teal-bg: #e0f2f1;
      --code-bg: #1e1e1e;
      --code-text: #d4d4d4;
      --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font-family);
      background-color: var(--ado-bg);
      color: var(--ado-text);
      line-height: 1.4;
      -webkit-font-smoothing: antialiased;
    }

    /* Top ADO Navigation */
    .ado-top-nav {
      background: var(--ado-nav-bg);
      color: #ffffff;
      height: 48px;
      display: flex;
      align-items: center;
      padding: 0 16px;
      gap: 16px;
      position: sticky;
      top: 0;
      z-index: 100;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .ado-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
      font-size: 15px;
      letter-spacing: -0.2px;
    }
    .ado-brand svg { width: 22px; height: 22px; fill: var(--ado-blue); }
    .ado-divider { color: #555; }
    .ado-project-name { font-weight: 500; font-size: 14px; color: #ccc; }
    .ado-nav-right {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .live-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      border-radius: 12px;
      background: rgba(16, 124, 16, 0.2);
      color: #4ade80;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .live-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #4ade80;
      box-shadow: 0 0 8px #4ade80;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .btn-refresh {
      background: #333;
      color: #fff;
      border: 1px solid #555;
      padding: 5px 12px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: background 0.15s;
    }
    .btn-refresh:hover { background: #444; }

    /* Sub-header Breadcrumb */
    .ado-sub-header {
      background: var(--ado-header-bg);
      border-bottom: 1px solid var(--ado-border);
      padding: 12px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .breadcrumbs {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: var(--ado-text-secondary);
    }
    .breadcrumbs strong {
      color: var(--ado-text);
      font-size: 18px;
      font-weight: 600;
    }
    .header-actions { display: flex; gap: 8px; align-items: center; }

    /* Tabs */
    .ado-tabs-bar {
      background: var(--ado-header-bg);
      border-bottom: 1px solid var(--ado-border);
      padding: 0 24px;
      display: flex;
      gap: 24px;
    }
    .ado-tab {
      padding: 12px 4px;
      font-size: 14px;
      font-weight: 500;
      color: var(--ado-text-secondary);
      border-bottom: 3px solid transparent;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: color 0.15s, border-color 0.15s;
    }
    .ado-tab:hover { color: var(--ado-blue); }
    .ado-tab.active {
      color: var(--ado-blue);
      border-bottom-color: var(--ado-blue);
      font-weight: 600;
    }
    .tab-count {
      background: #f0f0f0;
      padding: 1px 7px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
      color: var(--ado-text-secondary);
    }
    .ado-tab.active .tab-count {
      background: var(--ado-blue-light);
      color: var(--ado-blue);
    }

    /* Container */
    .main-container {
      max-width: 1440px;
      margin: 0 auto;
      padding: 20px 24px;
    }

    /* Summary KPI Cards */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .metric-card {
      background: var(--ado-card-bg);
      border: 1px solid var(--ado-border);
      border-radius: 6px;
      padding: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.03);
      position: relative;
      overflow: hidden;
    }
    .metric-card::before {
      content: "";
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 3px;
      background: var(--ado-blue);
    }
    .metric-card.success::before { background: var(--ado-green); }
    .metric-card.danger::before { background: var(--ado-red); }
    .metric-card.purple::before { background: var(--ado-purple); }
    .metric-card.teal::before { background: var(--ado-teal); }

    .metric-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--ado-text-secondary);
      margin-bottom: 6px;
    }
    .metric-value-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .metric-value {
      font-size: 28px;
      font-weight: 700;
      color: var(--ado-text);
      letter-spacing: -0.5px;
    }
    .metric-sub {
      font-size: 12px;
      color: var(--ado-text-secondary);
    }
    .metric-trend {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .trend-up { background: var(--ado-green-bg); color: var(--ado-green); }
    .trend-down { background: var(--ado-red-bg); color: var(--ado-red); }

    /* Filters Toolbar */
    .toolbar {
      background: var(--ado-card-bg);
      border: 1px solid var(--ado-border);
      border-radius: 6px;
      padding: 12px 16px;
      margin-bottom: 16px;
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      justify-content: space-between;
    }
    .filter-group {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .filter-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--ado-text-secondary);
    }
    .filter-select, .search-box input {
      border: 1px solid var(--ado-border);
      background: #ffffff;
      padding: 6px 10px;
      border-radius: 4px;
      font-size: 13px;
      color: var(--ado-text);
      outline: none;
      transition: border-color 0.15s;
    }
    .filter-select:focus, .search-box input:focus {
      border-color: var(--ado-blue);
      box-shadow: 0 0 0 1px var(--ado-blue);
    }
    .search-box {
      position: relative;
      display: flex;
      align-items: center;
    }
    .search-box input {
      width: 260px;
      padding-left: 28px;
    }
    .search-icon {
      position: absolute;
      left: 8px;
      color: var(--ado-text-muted);
      width: 14px;
      height: 14px;
    }

    /* Tables */
    .table-container {
      background: var(--ado-card-bg);
      border: 1px solid var(--ado-border);
      border-radius: 6px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0,0,0,0.03);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 13px;
    }
    thead th {
      background: #fafafa;
      color: var(--ado-text-secondary);
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--ado-border);
    }
    tbody tr {
      border-bottom: 1px solid #f0f0f0;
      transition: background 0.1s;
      cursor: pointer;
    }
    tbody tr:hover { background: #f9fbfd; }
    tbody tr.expanded-row { background: #f3f8fd; font-weight: 500; }
    td {
      padding: 10px 14px;
      vertical-align: middle;
    }

    /* Status Badges */
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: capitalize;
    }
    .status-pill.succeeded { background: var(--ado-green-bg); color: var(--ado-green); }
    .status-pill.failed { background: var(--ado-red-bg); color: var(--ado-red); }
    .status-pill.incomplete { background: #f3f2f1; color: var(--ado-text-secondary); }
    .status-pill.running { background: var(--ado-blue-light); color: var(--ado-blue); }

    .action-tag {
      font-family: Consolas, Monaco, monospace;
      font-size: 11px;
      padding: 2px 6px;
      background: #f0f0f0;
      border-radius: 3px;
      color: #333;
      font-weight: 600;
    }
    .action-tag.check { background: #e0f2fe; color: #0369a1; }
    .action-tag.setup { background: #fef3c7; color: #92400e; }
    .action-tag.push { background: #f3e8ff; color: #6b21a8; }

    .category-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 4px;
      text-transform: uppercase;
    }
    .cat-feat { background: #dbeafe; color: #1e40af; }
    .cat-fix { background: #fee2e2; color: #991b1b; }
    .cat-perf { background: #fef9c3; color: #854d0e; }
    .cat-docs { background: #e0e7ff; color: #3730a3; }
    .cat-refactor { background: #f3e8ff; color: #6b21a8; }
    .cat-default { background: #f3f4f6; color: #374151; }

    .pr-link {
      color: var(--ado-blue);
      text-decoration: none;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .pr-link:hover { text-decoration: underline; }

    /* Duration Bar */
    .duration-cell {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .duration-bar {
      flex: 1;
      max-width: 60px;
      height: 4px;
      background: #e5e7eb;
      border-radius: 2px;
      overflow: hidden;
    }
    .duration-bar-fill {
      height: 100%;
      background: var(--ado-blue);
    }
    .duration-bar-fill.long { background: var(--ado-orange); }

    /* Mini Step Indicators */
    .step-dots {
      display: flex;
      gap: 4px;
      align-items: center;
      flex-wrap: wrap;
    }
    .step-chip {
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
      background: #f0f0f0;
      color: var(--ado-text-secondary);
      white-space: nowrap;
    }
    .step-chip.passed { background: var(--ado-green-bg); color: var(--ado-green); font-weight: 600; }
    .step-chip.failed { background: var(--ado-red-bg); color: var(--ado-red); font-weight: 600; }

    /* Drawer / Expanded Run Details */
    .run-drawer {
      padding: 16px 20px;
      background: #fafbfc;
      border-top: 1px solid var(--ado-border);
      border-bottom: 2px solid var(--ado-border);
    }
    .drawer-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
      padding-bottom: 10px;
      border-bottom: 1px solid #e1dfdd;
    }
    .drawer-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--ado-text);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .drawer-meta {
      display: flex;
      gap: 16px;
      font-size: 12px;
      color: var(--ado-text-secondary);
    }

    /* ADO Pipeline Visual Stage Graph */
    .pipeline-graph {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
      overflow-x: auto;
      padding: 6px 0;
    }
    .stage-card {
      background: #ffffff;
      border: 1px solid var(--ado-border);
      border-radius: 6px;
      padding: 10px 14px;
      min-width: 200px;
      flex-shrink: 0;
      box-shadow: 0 1px 2px rgba(0,0,0,0.04);
      cursor: pointer;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .stage-card:hover {
      border-color: var(--ado-blue);
      box-shadow: 0 2px 6px rgba(0,120,212,0.15);
    }
    .stage-card.passed { border-left: 4px solid var(--ado-green); }
    .stage-card.failed { border-left: 4px solid var(--ado-red); }
    .stage-card.timedout { border-left: 4px solid var(--ado-orange); }

    .stage-name {
      font-size: 12px;
      font-weight: 600;
      color: var(--ado-text);
      margin-bottom: 4px;
    }
    .stage-sub {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      color: var(--ado-text-secondary);
    }

    .pipeline-arrow {
      color: var(--ado-text-muted);
      font-size: 16px;
      font-weight: bold;
    }

    /* Command Log Details Box */
    .log-box {
      background: var(--code-bg);
      color: var(--code-text);
      border-radius: 6px;
      padding: 12px 16px;
      font-family: Consolas, Monaco, "Courier New", monospace;
      font-size: 12px;
      overflow-x: auto;
      position: relative;
      margin-top: 10px;
      line-height: 1.5;
    }
    .log-copy-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.2);
      color: #fff;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
    }
    .log-copy-btn:hover { background: rgba(255,255,255,0.2); }

    .prose-block {
      background: #ffffff;
      border: 1px solid var(--ado-border);
      border-radius: 4px;
      padding: 10px 14px;
      margin-top: 8px;
      font-size: 13px;
    }
    .prose-title {
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      color: var(--ado-text-secondary);
      margin-bottom: 4px;
    }

    /* Target Analytics Grid */
    .analytics-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    @media (max-width: 900px) {
      .analytics-grid { grid-template-columns: 1fr; }
    }

    .card {
      background: var(--ado-card-bg);
      border: 1px solid var(--ado-border);
      border-radius: 6px;
      padding: 16px 20px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.03);
    }
    .card-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--ado-text);
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid #f0f0f0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .bar-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 10px;
      font-size: 12px;
    }
    .bar-label {
      width: 170px;
      font-weight: 500;
      color: var(--ado-text);
      text-overflow: ellipsis;
      overflow: hidden;
      white-space: nowrap;
    }
    .bar-track {
      flex: 1;
      height: 8px;
      background: #f0f0f0;
      border-radius: 4px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      background: var(--ado-blue);
      border-radius: 4px;
    }
    .bar-val {
      width: 70px;
      text-align: right;
      font-weight: 600;
      color: var(--ado-text-secondary);
    }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: var(--ado-text-muted);
      font-size: 14px;
    }
  </style>
</head>
<body>

  <!-- Top Navigation -->
  <header class="ado-top-nav">
    <div class="ado-brand">
      <svg viewBox="0 0 24 24"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM19 18H6c-2.21 0-4-1.79-4-4 0-2.05 1.53-3.76 3.56-3.97l1.07-.11.5-.95C8.08 7.14 9.94 6 12 6c2.62 0 4.88 1.86 5.39 4.43l.3 1.5 1.53.11c1.56.1 2.78 1.41 2.78 2.96 0 1.65-1.35 3-3 3z"/></svg>
      Azure DevOps
      <span class="ado-divider">/</span>
      <span class="ado-project-name">office-bohemia</span>
    </div>
    <div class="ado-nav-right">
      <span class="live-badge"><span class="live-dot"></span> Live Connected</span>
      <button class="btn-refresh" id="refreshBtn" onclick="refreshData()">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
        Refresh
      </button>
    </div>
  </header>

  <!-- Sub Header -->
  <div class="ado-sub-header">
    <div class="breadcrumbs">
      <span>Pipelines</span>
      <span class="ado-divider">/</span>
      <strong>Bohemia Local Gate & PR MCP Automation</strong>
    </div>
    <div class="header-actions">
      <span style="font-size: 12px; color: var(--ado-text-secondary);" id="lastUpdated">Updated just now</span>
    </div>
  </div>

  <!-- Tabs Navigation -->
  <div class="ado-tabs-bar">
    <div class="ado-tab active" data-tab="gate-runs" onclick="switchTab('gate-runs')">
      <span>⚡ Repo Gate Pipeline Runs</span>
      <span class="tab-count" id="gateRunsTabCount">0</span>
    </div>
    <div class="ado-tab" data-tab="pr-mcp" onclick="switchTab('pr-mcp')">
      <span>🔀 Pull Request MCP Operations</span>
      <span class="tab-count" id="prMcpTabCount">0</span>
    </div>
    <div class="ado-tab" data-tab="analytics" onclick="switchTab('analytics')">
      <span>📊 Metrics & Target Analytics</span>
    </div>
    <div class="ado-tab" data-tab="logs" onclick="switchTab('logs')">
      <span>🖥️ Live Command & Log Inspector</span>
    </div>
  </div>

  <div class="main-container">

    <!-- KPI Metric Cards -->
    <div class="metrics-grid">
      <div class="metric-card" id="cardTotalRuns">
        <div class="metric-title">Total Gate Runs</div>
        <div class="metric-value-row">
          <div class="metric-value" id="valTotalRuns">0</div>
          <span class="metric-trend trend-up" id="valGateRunsSubtitle">Active</span>
        </div>
        <div class="metric-sub" id="valPassRate">0% Pass Rate</div>
      </div>

      <div class="metric-card success" id="cardPassedRuns">
        <div class="metric-title">Succeeded Runs</div>
        <div class="metric-value-row">
          <div class="metric-value" id="valPassedRuns" style="color: var(--ado-green);">0</div>
        </div>
        <div class="metric-sub" id="valPassedSub">Local checks passed</div>
      </div>

      <div class="metric-card danger" id="cardFailedRuns">
        <div class="metric-title">Failed Checks</div>
        <div class="metric-value-row">
          <div class="metric-value" id="valFailedRuns" style="color: var(--ado-red);">0</div>
        </div>
        <div class="metric-sub" id="valFailedSub">Blocked before PR</div>
      </div>

      <div class="metric-card purple">
        <div class="metric-title">Avg Gate Duration</div>
        <div class="metric-value-row">
          <div class="metric-value" id="valAvgDuration">0s</div>
        </div>
        <div class="metric-sub" id="valDurationSub">Scoped package checks</div>
      </div>

      <div class="metric-card teal">
        <div class="metric-title">PR MCP Operations</div>
        <div class="metric-value-row">
          <div class="metric-value" id="valTotalMcp">0</div>
        </div>
        <div class="metric-sub" id="valMcpSub">Create & Update tools</div>
      </div>
    </div>

    <!-- Filters Toolbar -->
    <div class="toolbar">
      <div class="filter-group">
        <span class="filter-label">Filter:</span>
        <select class="filter-select" id="timeFilter" onchange="applyFilters()">
          <option value="24h" selected>🕒 Last 24 Hours</option>
          <option value="today">📅 Today</option>
          <option value="recent50">⚡ Last 50 Runs</option>
          <option value="all">🌐 All Time</option>
        </select>

        <select class="filter-select" id="statusFilter" onchange="applyFilters()">
          <option value="all">All Statuses</option>
          <option value="succeeded">✔ Succeeded</option>
          <option value="failed">✖ Failed</option>
          <option value="incomplete">⏳ Incomplete / In-Flight</option>
        </select>

        <select class="filter-select" id="actionFilter" onchange="applyFilters()">
          <option value="all">All Actions</option>
          <option value="push">bohemia push</option>
          <option value="check">bohemia check</option>
          <option value="setup">bohemia setup</option>
        </select>

        <select class="filter-select" id="repoFilter" onchange="applyFilters()">
          <option value="all">All Clones</option>
        </select>
      </div>

      <div class="search-box">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input type="text" id="searchInput" placeholder="Search by Run ID, PR #, command..." oninput="applyFilters()">
      </div>
    </div>

    <!-- TAB 1: Gate Pipeline Runs -->
    <div id="tab-gate-runs" class="tab-content">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th style="width: 120px;">Status</th>
              <th style="width: 140px;">Run ID</th>
              <th style="width: 110px;">Action</th>
              <th>Clone Repository</th>
              <th style="width: 130px;">Duration</th>
              <th>Executed Stages & Steps</th>
              <th style="width: 170px;">Triggered At</th>
            </tr>
          </thead>
          <tbody id="gateRunsTableBody">
            <!-- Dynamic rows -->
          </tbody>
        </table>
      </div>
    </div>

    <!-- TAB 2: Pull Request MCP Operations -->
    <div id="tab-pr-mcp" class="tab-content" style="display: none;">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th style="width: 110px;">Status</th>
              <th style="width: 110px;">PR #</th>
              <th style="width: 150px;">Tool</th>
              <th style="width: 90px;">Category</th>
              <th>Pull Request Title</th>
              <th style="width: 110px;">Duration</th>
              <th style="width: 170px;">Executed At</th>
            </tr>
          </thead>
          <tbody id="prMcpTableBody">
            <!-- Dynamic rows -->
          </tbody>
        </table>
      </div>
    </div>

    <!-- TAB 3: Metrics & Analytics -->
    <div id="tab-analytics" class="tab-content" style="display: none;">
      <div class="analytics-grid">
        <div class="card">
          <div class="card-title">
            <span>⏱️ Step Duration Breakdown (Average)</span>
          </div>
          <div id="stepDurationList">
            <!-- Dynamic bar chart -->
          </div>
        </div>

        <div class="card">
          <div class="card-title">
            <span>📂 Runs by Repository Clone</span>
          </div>
          <div id="repoDistributionList">
            <!-- Dynamic clone distribution -->
          </div>
        </div>

        <div class="card">
          <div class="card-title">
            <span>🎯 Actions Distribution</span>
          </div>
          <div id="actionDistributionList">
            <!-- Dynamic action breakdown -->
          </div>
        </div>

        <div class="card">
          <div class="card-title">
            <span>🛡️ Required Pipeline Gates Covered</span>
          </div>
          <div style="font-size: 13px; line-height: 1.6; color: var(--ado-text-secondary);">
            <div style="margin-bottom: 8px;"><strong>pr-build.yaml:</strong> Lage typecheck, lint, localize, prettier, knip, test</div>
            <div style="margin-bottom: 8px;"><strong>code-format-validation.yaml:</strong> Beachball, syncpack, dedup, lockfile check, package-json-formatter</div>
            <div style="margin-bottom: 8px;"><strong>compliance.yaml:</strong> SDL required lint on changed files</div>
            <div><strong>AI Attribution Guard:</strong> Automatic rejection of Copilot/Claude co-author trailers</div>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 4: Live Command Inspector -->
    <div id="tab-logs" class="tab-content" style="display: none;">
      <div class="card">
        <div class="card-title">
          <span>📜 Exact Commands & Gate Steps Executed</span>
          <span style="font-size: 12px; font-weight: normal; color: var(--ado-text-secondary);" id="commandsCount">0 commands</span>
        </div>
        <div id="commandLogsContainer">
          <!-- Dynamic logs -->
        </div>
      </div>
    </div>

  </div>

  <script>
    // Embedded initial data
    let currentData = ${dataJson};
    let activeTab = "gate-runs";
    let expandedRunId = null;
    let expandedMcpId = null;

    function escapeHtml(value) {
      const element = document.createElement("span");
      element.textContent = String(value ?? "");
      return element.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function safeUrl(value) {
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) ? escapeHtml(url.href) : "#";
      } catch { return "#"; }
    }

    function formatSeconds(secs) {
      if (secs === null || secs === undefined) return "-";
      if (secs < 60) return secs + "s";
      const m = Math.floor(secs / 60);
      const s = Math.round(secs % 60);
      return \`\${m}m \${s}s\`;
    }

    function formatDate(isoStr) {
      if (!isoStr) return "-";
      try {
        const d = new Date(isoStr);
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
               d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      } catch(e) {
        return isoStr;
      }
    }

    function switchTab(tabId) {
      activeTab = tabId;
      document.querySelectorAll(".ado-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tabId));
      document.querySelectorAll(".tab-content").forEach(c => c.style.display = (c.id === "tab-" + tabId) ? "block" : "none");
      applyFilters();
    }

    function toggleRunExpand(runId) {
      expandedRunId = (expandedRunId === runId) ? null : runId;
      renderGateRuns();
    }

    function toggleMcpExpand(idx) {
      expandedMcpId = (expandedMcpId === idx) ? null : idx;
      renderMcpRuns();
    }

    function copyToClipboard(text, btn) {
      navigator.clipboard.writeText(text).then(() => {
        const old = btn.innerText;
        btn.innerText = "Copied!";
        setTimeout(() => btn.innerText = old, 1500);
      });
    }

    function populateFilters() {
      const repos = new Set();
      (currentData.gateRuns || []).forEach(r => {
        if (r.repo) {
          const name = r.repo.split(/[\\\\\\/]/).pop();
          repos.add(name);
        }
      });
      const select = document.getElementById("repoFilter");
      const currentVal = select.value;
      select.innerHTML = '<option value="all">All Clones</option>';
      Array.from(repos).sort().forEach(repo => {
        const opt = document.createElement("option");
        opt.value = repo;
        opt.textContent = repo;
        select.appendChild(opt);
      });
      select.value = currentVal;
    }

    function getFilteredGateRuns() {
      const timeF = document.getElementById("timeFilter") ? document.getElementById("timeFilter").value : "24h";
      const now = Date.now();
      let runs = (currentData.gateRuns || []);

      if (timeF === "24h") {
        const cutoff = now - 24 * 3600 * 1000;
        runs = runs.filter(r => {
          const t = r.startTime || (r.steps && r.steps[0] && r.steps[0].at) || r.endTime;
          return t ? new Date(t).getTime() >= cutoff : true;
        });
      } else if (timeF === "today") {
        const todayStr = new Date().toISOString().slice(0, 10);
        runs = runs.filter(r => {
          const t = r.startTime || (r.steps && r.steps[0] && r.steps[0].at) || r.endTime;
          return t ? t.startsWith(todayStr) : true;
        });
      } else if (timeF === "recent50") {
        runs = runs.slice(0, 50);
      }
      return runs;
    }

    function updateKPIs() {
      const allGateRuns = currentData.gateRuns || [];
      const mcpRuns = currentData.mcpRuns || [];
      const gateRuns = getFilteredGateRuns();

      document.getElementById("gateRunsTabCount").textContent = allGateRuns.length;
      document.getElementById("prMcpTabCount").textContent = mcpRuns.length;

      const passed = gateRuns.filter(r => r.status === "succeeded").length;
      const failed = gateRuns.filter(r => r.status === "failed").length;
      const total = gateRuns.length;
      const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

      const validDurs = gateRuns.filter(r => r.durationSeconds && r.durationSeconds < 3600);
      const durTotal = validDurs.reduce((a, b) => a + b.durationSeconds, 0);
      const durCount = validDurs.length;
      const avgDur = durCount > 0 ? Math.round(durTotal / durCount) : 0;

      const timeF = document.getElementById("timeFilter") ? document.getElementById("timeFilter").value : "24h";
      const timeLabel = timeF === "24h" ? "Last 24h" : timeF === "today" ? "Today" : timeF === "recent50" ? "Last 50" : "All Time";

      document.getElementById("valTotalRuns").textContent = total;
      document.getElementById("valPassRate").textContent = passRate + "% Pass Rate";
      document.getElementById("valPassedRuns").textContent = passed;
      document.getElementById("valFailedRuns").textContent = failed;
      document.getElementById("valAvgDuration").textContent = formatSeconds(avgDur);
      document.getElementById("valDurationSub").textContent = "Avg duration (" + timeLabel + ")";
      document.getElementById("valTotalMcp").textContent = mcpRuns.length;
    }

    function applyFilters() {
      updateKPIs();
      if (activeTab === "gate-runs") renderGateRuns();
      else if (activeTab === "pr-mcp") renderMcpRuns();
      else if (activeTab === "analytics") renderAnalytics();
      else if (activeTab === "logs") renderLogs();
    }

    function renderGateRuns() {
      const statusF = document.getElementById("statusFilter").value;
      const actionF = document.getElementById("actionFilter").value;
      const repoF = document.getElementById("repoFilter").value;
      const search = document.getElementById("searchInput").value.toLowerCase().trim();

      const baseRuns = getFilteredGateRuns();
      const runs = baseRuns.filter(r => {
        if (statusF !== "all" && r.status !== statusF) return false;
        if (actionF !== "all" && r.action !== actionF) return false;
        if (repoF !== "all") {
          const repoName = (r.repo || "").split(/[\\\\\\/]/).pop();
          if (repoName !== repoF) return false;
        }
        if (search) {
          const matchId = (r.runId || "").toLowerCase().includes(search);
          const matchRepo = (r.repo || "").toLowerCase().includes(search);
          const matchStep = (r.steps || []).some(s => (s.step || "").toLowerCase().includes(search) || (s.command || "").toLowerCase().includes(search));
          if (!matchId && !matchRepo && !matchStep) return false;
        }
        return true;
      });

      const tbody = document.getElementById("gateRunsTableBody");
      if (!runs.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No gate pipeline runs match the selected filters.</td></tr>';
        return;
      }

      const maxDur = Math.max(...runs.map(r => r.durationSeconds || 0), 1);

      tbody.innerHTML = runs.map(r => {
        const isExpanded = (expandedRunId === r.runId);
        const repoName = (r.repo || "office-bohemia").split(/[\\\\\\/]/).pop();
        const dur = r.durationSeconds || 0;
        const durPercent = Math.min(100, Math.round((dur / maxDur) * 100));

        let statusClass = r.status;
        let statusIcon = "✔";
        let statusText = r.status;
        if (r.status === "failed") {
          statusIcon = "✖";
          statusText = "Failed";
        } else if (r.status === "incomplete") {
          statusClass = "running";
          statusIcon = "⏳";
          statusText = "In-Flight";
        } else if (r.status === "succeeded") {
          statusText = "Succeeded";
        }

        const stepChips = (r.steps || []).map(s => {
          const cls = s.failed ? "failed" : "passed";
          const icon = s.failed ? "✖" : "✔";
          let shortName = s.step;
          if (shortName.includes("consistency")) shortName = "Consistency";
          else if (shortName.includes("SDL")) shortName = "SDL Lint";
          else if (shortName.includes("Build, tests")) shortName = "Lage Gates";
          else if (shortName.includes("Install")) shortName = "Yarn Install";
          else if (shortName.includes("Warm")) shortName = "Warm Build";
          return \`<span class="step-chip \${cls}">\${icon} \${escapeHtml(shortName)} (\${escapeHtml(s.seconds)}s)</span>\`;
        }).join(" ");

        let rowHtml = \`
          <tr class="\${isExpanded ? 'expanded-row' : ''}" data-run-id="\${escapeHtml(r.runId)}" onclick="toggleRunExpand(this.dataset.runId)">
            <td>
              <span class="status-pill \${statusClass}">\${statusIcon} \${statusText}</span>
            </td>
            <td>
              <strong style="font-family: monospace; color: var(--ado-blue);">#\${escapeHtml(r.runId)}</strong>
            </td>
            <td>
              <span class="action-tag">\${escapeHtml(r.action || 'check')}</span>
            </td>
            <td>
              <span title="\${escapeHtml(r.repo || '')}" style="font-weight: 500;">\${escapeHtml(repoName)}</span>
            </td>
            <td>
              <div class="duration-cell">
                <span>\${formatSeconds(r.durationSeconds)}</span>
                <div class="duration-bar">
                  <div class="duration-bar-fill \${dur > 600 ? 'long' : ''}" style="width: \${durPercent}%;"></div>
                </div>
              </div>
            </td>
            <td>
              <div class="step-dots">\${stepChips || '<span style="color:var(--ado-text-muted);font-size:11px;">No recorded steps</span>'}</div>
            </td>
            <td style="color: var(--ado-text-secondary); font-size: 12px;">
              \${formatDate(r.startTime || (r.steps[0] ? r.steps[0].at : ''))}
            </td>
          </tr>
        \`;

        if (isExpanded) {
          const stagesHtml = (r.steps || []).map(s => {
            const cls = s.failed ? "failed" : (s.timedOut ? "timedout" : "passed");
            const statusText = s.failed ? "Failed" : (s.timedOut ? "Timed Out" : "Passed");
            return \`
              <div class="stage-card \${cls}">
                <div class="stage-name">\${escapeHtml(s.step)}</div>
                <div class="stage-sub">
                  <span>\${statusText} in <strong>\${escapeHtml(s.seconds)}s</strong></span>
                  <span>Limit: \${escapeHtml(s.limit)}s</span>
                </div>
              </div>
            \`;
          }).join('<span class="pipeline-arrow">➔</span>');

          const stepsDetail = (r.steps || []).map((s, idx) => {
            return \`
              <div style="margin-top: 12px;">
                <div style="font-weight: 600; font-size: 12px; color: var(--ado-text); display: flex; justify-content: space-between;">
                  <span>Step \${idx + 1}: \${escapeHtml(s.step)} (\${escapeHtml(s.seconds)}s)</span>
                  <span style="color: \${s.failed ? 'var(--ado-red)' : 'var(--ado-green)'};">\${s.failed ? 'FAILED' : 'PASSED'}</span>
                </div>
                \${s.reason ? \`
                  <div style="background: var(--ado-red-bg); color: var(--ado-red); padding: 8px 12px; border-radius: 4px; font-size: 12px; margin-top: 6px; font-weight: 500;">
                    \${escapeHtml(s.reason)}
                  </div>
                \` : ''}
                \${s.command ? \`
                  <div class="log-box">
                    <button class="log-copy-btn" onclick="event.stopPropagation(); copyToClipboard(this.nextElementSibling.textContent, this)">Copy Command</button>
                    <code>\${escapeHtml(s.command)}</code>
                  </div>
                \` : ''}
              </div>
            \`;
          }).join("");

          rowHtml += \`
            <tr>
              <td colspan="7" style="padding: 0;">
                <div class="run-drawer">
                  <div class="drawer-header">
                    <div class="drawer-title">
                      <span>Pipeline Run #\${escapeHtml(r.runId)} Details</span>
                      <span class="status-pill \${statusClass}">\${r.status}</span>
                    </div>
                    <div class="drawer-meta">
                      <span>Action: <strong>\${escapeHtml(r.action)}</strong></span>
                      <span>Duration: <strong>\${formatSeconds(r.durationSeconds)}</strong></span>
                      <span>Exit Code: <strong>\${escapeHtml(r.exitCode !== null ? r.exitCode : 'N/A')}</strong></span>
                      <span>PID: <strong>\${escapeHtml(r.pid || 'N/A')}</strong></span>
                    </div>
                  </div>

                  <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--ado-text-secondary); margin-bottom: 6px;">
                    Pipeline Stage Timeline
                  </div>
                  <div class="pipeline-graph">
                    \${stagesHtml || '<div style="color: var(--ado-text-muted); font-size: 12px;">No recorded pipeline stages for this run.</div>'}
                  </div>

                  \${stepsDetail}
                </div>
              </td>
            </tr>
          \`;
        }

        return rowHtml;
      }).join("");
    }

    function renderMcpRuns() {
      const search = document.getElementById("searchInput").value.toLowerCase().trim();
      const statusF = document.getElementById("statusFilter").value;

      const mcp = (currentData.mcpRuns || []).filter(m => {
        if (statusF === "succeeded" && !m.success) return false;
        if (statusF === "failed" && m.success) return false;
        if (search) {
          const matchTitle = (m.title || "").toLowerCase().includes(search);
          const matchPr = String(m.prId || "").includes(search);
          const matchTool = (m.toolName || "").toLowerCase().includes(search);
          const matchRes = (m.result || "").toLowerCase().includes(search);
          if (!matchTitle && !matchPr && !matchTool && !matchRes) return false;
        }
        return true;
      });

      const tbody = document.getElementById("prMcpTableBody");
      if (!mcp.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No Pull Request MCP operations match filters.</td></tr>';
        return;
      }

      tbody.innerHTML = mcp.map((m, idx) => {
        const isExpanded = (expandedMcpId === idx);
        const statusClass = m.success ? "succeeded" : "failed";
        const statusIcon = m.success ? "✔" : "✖";
        const cat = (m.category || m.args?.category || "general").toLowerCase();
        let catClass = "cat-default";
        if (cat === "feat") catClass = "cat-feat";
        else if (cat === "fix") catClass = "cat-fix";
        else if (cat === "perf") catClass = "cat-perf";
        else if (cat === "docs") catClass = "cat-docs";
        else if (cat === "refactor") catClass = "cat-refactor";

        const prTitle = m.title || m.args?.title || (m.prId ? "PR #" + m.prId : "Branch / Repo Operation");

        let rowHtml = \`
          <tr class="\${isExpanded ? 'expanded-row' : ''}" onclick="toggleMcpExpand(\${idx})">
            <td>
              <span class="status-pill \${statusClass}">\${statusIcon} \${m.success ? 'Succeeded' : 'Failed'}</span>
            </td>
            <td>
              \${m.prId ? \`<a href="\${safeUrl(m.prUrl)}" target="_blank" rel="noopener noreferrer" class="pr-link" onclick="event.stopPropagation()">#\${escapeHtml(m.prId)} ↗</a>\` : '-'}
            </td>
            <td>
              <span class="action-tag">\${escapeHtml(m.toolName)}</span>
            </td>
            <td>
              <span class="category-badge \${catClass}">\${escapeHtml(cat)}</span>
            </td>
            <td>
              <span style="font-weight: 600; color: var(--ado-text);">\${escapeHtml(prTitle)}</span>
            </td>
            <td>
              <span>\${formatSeconds(m.durationSeconds)}</span>
            </td>
            <td style="color: var(--ado-text-secondary); font-size: 12px;">
              \${formatDate(m.startedAt || m.completedAt)}
            </td>
          </tr>
        \`;

        if (isExpanded) {
          rowHtml += \`
            <tr>
              <td colspan="7" style="padding: 0;">
                <div class="run-drawer">
                  <div class="drawer-header">
                    <div class="drawer-title">
                      <span>\${escapeHtml(m.toolName)} - \${escapeHtml(prTitle)}</span>
                      \${m.prUrl ? \`<a href="\${safeUrl(m.prUrl)}" target="_blank" rel="noopener noreferrer" class="pr-link" style="font-size: 12px;">Open Azure DevOps PR #\${escapeHtml(m.prId)} ↗</a>\` : ''}
                    </div>
                    <div class="drawer-meta">
                      <span>Duration: <strong>\${formatSeconds(m.durationSeconds)}</strong></span>
                      <span>Session: <strong>\${escapeHtml((m.sessionId || '').slice(0, 8))}...</strong></span>
                    </div>
                  </div>

                  \${m.args?.problem ? \`
                    <div class="prose-block">
                      <div class="prose-title">Problem Statement</div>
                      <div>\${escapeHtml(m.args.problem)}</div>
                    </div>
                  \` : ''}

                  \${m.args?.solution ? \`
                    <div class="prose-block">
                      <div class="prose-title">Solution</div>
                      <div>\${escapeHtml(m.args.solution)}</div>
                    </div>
                  \` : ''}

                  \${m.args?.validation ? \`
                    <div class="prose-block">
                      <div class="prose-title">Validation</div>
                      <div>\${escapeHtml(m.args.validation)}</div>
                    </div>
                  \` : ''}

                  \${m.result ? \`
                    <div style="margin-top: 10px;">
                      <div class="prose-title">Tool Result / Gate Transcript</div>
                      <div class="log-box">
                        <pre style="white-space: pre-wrap;">\${escapeHtml(m.result)}</pre>
                      </div>
                    </div>
                  \` : ''}
                </div>
              </td>
            </tr>
          \`;
        }

        return rowHtml;
      }).join("");
    }

    function renderAnalytics() {
      const gateRuns = currentData.gateRuns || [];
      const stepTimes = {};
      const repoCounts = {};
      const actionCounts = {};

      gateRuns.forEach(r => {
        const repo = (r.repo || "office-bohemia").split(/[\\\\\\/]/).pop();
        repoCounts[repo] = (repoCounts[repo] || 0) + 1;
        const act = r.action || "check";
        actionCounts[act] = (actionCounts[act] || 0) + 1;

        (r.steps || []).forEach(s => {
          if (!stepTimes[s.step]) stepTimes[s.step] = { count: 0, totalSec: 0 };
          stepTimes[s.step].count += 1;
          stepTimes[s.step].totalSec += (s.seconds || 0);
        });
      });

      // Render step times
      const stepContainer = document.getElementById("stepDurationList");
      const stepsArr = Object.entries(stepTimes).map(([name, d]) => ({
        name,
        avg: Math.round(d.totalSec / d.count),
        count: d.count
      })).sort((a,b) => b.avg - a.avg);

      const maxAvg = Math.max(...stepsArr.map(s => s.avg), 1);
      stepContainer.innerHTML = stepsArr.map(s => \`
        <div class="bar-row">
          <div class="bar-label" title="\${escapeHtml(s.name)}">\${escapeHtml(s.name)}</div>
          <div class="bar-track">
            <div class="bar-fill" style="width: \${(s.avg / maxAvg) * 100}%;"></div>
          </div>
          <div class="bar-val">\${formatSeconds(s.avg)} <span style="font-size:10px;color:var(--ado-text-muted);">(\${s.count})</span></div>
        </div>
      \`).join("");

      // Render repo distribution
      const repoContainer = document.getElementById("repoDistributionList");
      const repoArr = Object.entries(repoCounts).map(([name, count]) => ({ name, count })).sort((a,b) => b.count - a.count);
      const maxRepo = Math.max(...repoArr.map(r => r.count), 1);
      repoContainer.innerHTML = repoArr.map(r => \`
        <div class="bar-row">
          <div class="bar-label" title="\${escapeHtml(r.name)}">\${escapeHtml(r.name)}</div>
          <div class="bar-track">
            <div class="bar-fill" style="width: \${(r.count / maxRepo) * 100}%; background: var(--ado-teal);"></div>
          </div>
          <div class="bar-val">\${r.count} runs</div>
        </div>
      \`).join("");

      // Render actions
      const actContainer = document.getElementById("actionDistributionList");
      const actArr = Object.entries(actionCounts).map(([name, count]) => ({ name, count })).sort((a,b) => b.count - a.count);
      const maxAct = Math.max(...actArr.map(a => a.count), 1);
      actContainer.innerHTML = actArr.map(a => \`
        <div class="bar-row">
          <div class="bar-label" title="bohemia \${a.name}">bohemia \${a.name}</div>
          <div class="bar-track">
            <div class="bar-fill" style="width: \${(a.count / maxAct) * 100}%; background: var(--ado-purple);"></div>
          </div>
          <div class="bar-val">\${a.count} runs</div>
        </div>
      \`).join("");
    }

    function renderLogs() {
      const search = document.getElementById("searchInput").value.toLowerCase().trim();
      const gateRuns = currentData.gateRuns || [];
      const allSteps = [];
      gateRuns.forEach(r => {
        (r.steps || []).forEach(s => {
          if (!search || s.step.toLowerCase().includes(search) || (s.command || "").toLowerCase().includes(search) || r.runId.toLowerCase().includes(search)) {
            allSteps.push({ ...s, runId: r.runId, repo: r.repo, action: r.action });
          }
        });
      });

      document.getElementById("commandsCount").textContent = allSteps.length + " commands executed";
      const container = document.getElementById("commandLogsContainer");
      if (!allSteps.length) {
        container.innerHTML = '<div class="empty-state">No matching command logs found.</div>';
        return;
      }

      container.innerHTML = allSteps.slice(0, 50).map(s => \`
        <div style="margin-bottom: 16px; border-bottom: 1px solid #333; padding-bottom: 12px;">
          <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 6px;">
            <div>
              <strong style="color: #60a5fa;">#\${escapeHtml(s.runId)}</strong> &bull;
              <span style="color: #cbd5e1;">\${escapeHtml(s.step)}</span> &bull;
              <span style="color: #94a3b8;">\${escapeHtml((s.repo || '').split(/[\\\\\\/]/).pop())}</span>
            </div>
            <div>
              <span style="color: \${s.failed ? '#f87171' : '#4ade80'}; font-weight: 600;">\${s.failed ? 'FAIL' : 'PASS'} (\${s.seconds}s)</span>
              &bull; <span style="color: #94a3b8;">\${formatDate(s.at)}</span>
            </div>
          </div>
          <div class="log-box" style="margin-top: 0;">
            <button class="log-copy-btn" onclick="copyToClipboard(this.nextElementSibling.textContent, this)">Copy</button>
            <code>\${escapeHtml(s.command)}</code>
          </div>
        </div>
      \`).join("");
    }

    async function refreshData() {
      const btn = document.getElementById("refreshBtn");
      btn.innerHTML = "Refreshing...";
      try {
        const res = await fetch("/api/data?_t=" + Date.now(), { cache: "no-store" });
        if (!res.ok) throw new Error("Dashboard returned HTTP " + res.status);
        currentData = await res.json();
        document.getElementById("lastUpdated").textContent = currentData.diagnostics?.length
          ? "Data warning: " + currentData.diagnostics.join("; ")
          : "Updated " + new Date().toLocaleTimeString();
      } catch(e) {
        document.getElementById("lastUpdated").textContent = "STALE DATA: " + e.message;
        console.error(e);
      }
      populateFilters();
      updateKPIs();
      applyFilters();
      btn.innerHTML = \`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Refresh\`;
    }

    // Auto-poll if running under server
    setInterval(refreshData, 10000);

    // Initial boot & immediate live fetch
    populateFilters();
    updateKPIs();
    applyFilters();
    refreshData();
  </script>
</body>
</html>
`;

return html;
}
