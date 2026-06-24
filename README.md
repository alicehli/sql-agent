# SQL Agent

A conversational AI assistant for data analysis with SQL queries and Python execution in a secure sandbox.

## Features

- **SQL Queries** - Query DuckDB database with TPC-H sample data
- **Python Execution** - Run Python code in isolated E2B sandbox
- **Visualizations** - Generate charts with matplotlib, saved to sandbox
- **Session Branching** - Steins;Gate style worldlines - branch conversations and sandbox state
- **Persistent Sessions** - Resume conversations with full context
- **Versus Comparison** - Side-by-side demo running the same question across four agent setups (see [Routes](#routes))

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

The four Versus lanes are:

| Lane | Setup |
|------|-------|
| A · Generic sandbox | Claude Agent SDK harness + Modal (DIY connector) |
| B · TextQL Sandcastle | Claude Agent SDK harness + Sandcastle (prebuilt connector) |
| C · Ana via MCP | Claude Agent SDK harness + TextQL MCP → Ana |
| D · Ana API | Direct `/v2/chats` call to Ana |

The view renders without extra setup, but lanes only produce output when their backends are reachable: `SANDBOX_*` for lanes B/C, Modal (`scripts/modal_op.py`) for lane A, and Ana API access for lanes C/D.

## Environment Variables

```
ANTHROPIC_API_KEY=sk-ant-...     # Claude API
E2B_API_KEY=e2b_...              # Sandbox execution
CLERK_PUBLISHABLE_KEY=pk_...     # Authentication
CLERK_SECRET_KEY=sk_...
VITE_CLERK_PUBLISHABLE_KEY=pk_...
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
