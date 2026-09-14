# 📦 Spool

**Lean, high-performance agent work-item queue & supervisor in Rust.**

Zero database crashes. Zero heavy orchestration chatter. Pure deterministic execution via file-based mailbox queues, Copilot CLI execution, and an interactive TUI dashboard.

---

## ⚡ Key Features

1. **Watched File Queues (Mailbox Spool)**:
   - Each agent owns `incoming/`, `in_progress/`, `completed/`, and `failed/` queues.
   - Atomic file transitions (`fs::rename`) prevent lock contention and race conditions.
   - Instant recovery: stale tasks are safely re-claimed without DB state corruption.

2. **Copilot CLI Integration**:
   - Spawns `copilot -p` with full `--allow-all` permissions.
   - Streams JSONL transcripts to `logs/<task_id>.log`.
   - Caches and resumes sessions seamlessly via `--session-id <uuid>`.

3. **Built-in MCP Server**:
   - `spool mcp --agent <name> --task <id>` exposes stdio MCP tools:
     - `spool_get_task`: Inspect current task contract.
     - `spool_update_task_status`: Mark completed/failed with progress notes.
     - `spool_add_comment`: Append live notes to the work item.

4. **Token & Cost Ledger**:
   - Model pricing table (GPT-5.4, GPT-5 Mini, Gemini Flash, Claude Sonnet/Opus).
   - Tracks input, output, cache-read, and cache-write token costs per agent and per task.

5. **Ratatui Terminal TUI Dashboard**:
   - Live fleet table showing running status, active tasks, queue depths, total costs, and streaming activity.

---

## 🚀 Usage

### 1. Start the Live Dashboard
```bash
cargo run --release -- run
```

### 2. Submit a Task to an Agent
```bash
cargo run --release -- submit \
  --agent perf \
  --title "Optimize header bundle imports" \
  --prompt "Remove eager imports of heavy icons in packages/ux/header.tsx"
```

### 3. Check Fleet Status
```bash
cargo run --release -- status
```

### 4. Run Automated E2E Self-Test
```bash
cargo run --release -- test-e2e
```
