# SQL Agent

A conversational AI assistant for data analysis with SQL queries and Python execution in a secure sandbox.

## Features

- **SQL Queries** - Query DuckDB database with TPC-H sample data
- **Python Execution** - Run Python code in isolated E2B sandbox
- **Visualizations** - Generate charts with matplotlib, saved to sandbox
- **Session Branching** - Steins;Gate style worldlines - branch conversations and sandbox state
- **Persistent Sessions** - Resume conversations with full context
- **Versus Comparison** - Side-by-side demo running the same question across four agent setups (see [Versus](#versus))

## Quick Start

```bash
# Install dependencies
pnpm install

# Configure environment
cp .env.example .env
# Fill in API keys in .env

# Run development server
pnpm dev

# Open http://localhost:5173
```

## Routes

The app serves two distinct UIs from the same server. Both require signing in (Clerk) — until you do, every path shows the sign-in screen.

| Path | UI | Description |
|------|----|-------------|
| `/` | **Sidekick** (default) | The main chat agent: ask a question, Claude runs SQL/Python in the sandbox, with a data connectors panel. |
| `/compare` or `/versus` | **Versus** | Four side-by-side lanes answering the same question, to compare agent approaches. |

> **Note:** There is no in-app link to the Versus view — navigate to `http://localhost:5173/compare` (or `/versus`) directly. The path match is exact, so omit any trailing slash (`/compare`, not `/compare/`).

## Versus

The Versus view runs the same question across four agent setups to compare performance.

| Lane | Setup |
|------|-------|
| A · Generic sandbox | Claude Agent SDK harness + Modal (DIY connector) |
| B · TextQL Sandcastle | Claude Agent SDK harness + Sandcastle (prebuilt connector) |
| C · Ana via MCP | Claude Agent SDK harness + TextQL MCP → Ana |
| D · Ana API | Direct `/v2/chats` call to Ana |

The view renders without extra setup, but lanes only produce output when their backends are reachable: `SANDBOX_*` for lanes B/C, Modal (`scripts/modal_op.py`) for lane A, and Ana API access for lanes C/D.

> **Per-lane orgs:** By default all TextQL-backed lanes (B, C, D) share `SANDBOX_API_KEY` and `COMPARE_CONNECTOR_ID`. To isolate each lane in its own org (recommended for clean benchmarks), set the suffixed variants (`SANDBOX_API_KEY_B`, `COMPARE_CONNECTOR_ID_B`, etc.). Each lane falls back to the shared value if its suffix isn't set.

### Benchmark Suite

Click **Run suite** to execute every query `runsPerQuery` times (default 5) per lane. Runs are sequential within a lane, and the suite reuses the same sandbox across runs — `fresh: true` resets the conversation but not the sandbox's `./library`, so ontology files written in run 1 persist for subsequent runs.

### Insights

Click **Insights** in the Versus header after running a suite. The view shows, per query:

- **Aggregate stats** — median, min–max, and σ for time and tool calls per lane.
- **Derived metrics** — three headline ratios: B vs A speed, B convergence (run N vs run 1), and B vs D gap-to-production. Lane C is excluded (tool call counts are misleading behind the MCP boundary).
- **Per-run breakdown** — each lane's time and tool calls for every individual run.
- **Convergence chart** — line chart (runs on x-axis, time on y-axis) showing how each lane's time changes across runs, with Sandcastle emphasized.

## Environment Variables

```
# Core
ANTHROPIC_API_KEY=sk-ant-...          # Claude API
E2B_API_KEY=e2b_...                   # Sandbox execution
CLERK_PUBLISHABLE_KEY=pk_...          # Authentication
CLERK_SECRET_KEY=sk_...
VITE_CLERK_PUBLISHABLE_KEY=pk_...

# Versus — shared defaults (used if per-lane vars are not set)
SANDBOX_API_KEY=...                   # TextQL API key (lanes B, C, D)
SANDBOX_BASE_URL=https://app.textql.com
COMPARE_CONNECTOR_ID=628              # TextQL connector id
COMPARE_MODEL=sonnet                  # Claude model for lanes A/B
COMPARE_MCP_MODEL=sonnet              # Claude model for lane C

# Versus — per-lane org credentials (optional, fall back to shared)
SANDBOX_API_KEY_B=...                 # Lane B (Sandcastle) org key
SANDBOX_API_KEY_C=...                 # Lane C (Ana via MCP) org key
SANDBOX_API_KEY_D=...                 # Lane D (Ana direct) org key
COMPARE_CONNECTOR_ID_B=...            # Lane B connector id
COMPARE_CONNECTOR_ID_C=...            # Lane C connector id
COMPARE_CONNECTOR_ID_D=...            # Lane D connector id

# Versus — lane A (Modal / DIY)
SNOWFLAKE_USER=...                    # Snowflake credentials for generic sandbox
SNOWFLAKE_PASSWORD=...
SNOWFLAKE_ACCOUNT=...
SNOWFLAKE_ROLE=...
SNOWFLAKE_DATABASE=US_REAL_ESTATE
SNOWFLAKE_SCHEMA=CYBERSYN
SNOWFLAKE_WAREHOUSE=...
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        React UI                              │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ Sessions │  │    Chat      │  │   Sandbox Files        │ │
│  │ Sidebar  │  │   Messages   │  │   Browser              │ │
│  └──────────┘  └──────────────┘  └────────────────────────┘ │
└─────────────────────────┬───────────────────────────────────┘
                          │ WebSocket
┌─────────────────────────▼───────────────────────────────────┐
│                    Express Server                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Claude SDK   │  │  E2B Sandbox │  │  DuckDB          │   │
│  │ Agent Loop   │  │  (Python)    │  │  (TPC-H Data)    │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Project Structure

```
├── src/
│   ├── client/          # React frontend
│   │   ├── components/  # UI components
│   │   ├── hooks/       # React hooks
│   │   └── state/       # Jotai atoms
│   └── server/          # Express backend
│       ├── api/         # REST endpoints
│       ├── db/          # Session database
│       ├── sandbox/     # E2B integration
│       └── tools/       # MCP tool servers
├── packages/            # Shared libraries
│   ├── server/          # SDK session management
│   ├── messages/        # Message parsing
│   └── websocket/       # WebSocket handling
└── deploy/              # Deployment scripts
```

## Key Design Decisions

1. **E2B Sandboxing** - All code execution in isolated sandboxes for security
2. **Git-based State** - Sandbox snapshots after each turn enable branching
3. **WebSocket Streaming** - Real-time message streaming for responsive UI
4. **Session Branching** - Fork conversations to explore alternatives

## Live Demo

http://34.60.133.177
