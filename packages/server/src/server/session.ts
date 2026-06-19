import { randomUUID } from "node:crypto";

import {
  buildUserMessageContent,
  type AttachmentPayload,
  type UsageSummary,
} from "@claude-agent-kit/messages";
import type {
  BranchResult,
  ClaudeConfig,
  SessionConfig,
  IClaudeAgentSDKClient,
  ISessionClient,
  OutcomingMessage,
  SessionStateUpdate,
  SessionStateSnapshot,
  SessionSDKOptions,
} from "../types";
import type {
  SDKMessage,
  SDKSystemMessage,
  SDKUserMessage,
  Options as SDKOptions,
  McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";

// Only safe tools that don't access local filesystem
// Sandbox and SQL tools are added via configureSessionMcpServers in server.ts
const DEFAULT_ALLOWED_TOOLS: readonly string[] = [
  // "Task",        // Disabled - spawns subagents which don't have sandbox access
  "ExitPlanMode",
  // "Glob",        // Local filesystem - disabled
  // "Grep",        // Local filesystem - disabled
  // "LS",          // Local filesystem - disabled
  // "Read",        // Local filesystem - disabled
  // "Edit",        // Local filesystem - disabled
  // "MultiEdit",   // Local filesystem - disabled
  // "Write",       // Local filesystem - disabled
  // "NotebookEdit",// Local filesystem - disabled
  "WebFetch",
  "TodoWrite",
  "WebSearch",
  "Skill",         // Enable skills from .claude/skills/
];

const REPORT_MODE_INSTRUCTIONS = `

## Report Mode (ENABLED) - MANDATORY REPORT GENERATION

**CRITICAL: Report Mode is active. You MUST generate a professional HTML report as the final deliverable for EVERY request.**

No matter what the user asks, your response MUST end with a polished HTML report saved to \`/home/user/report.html\`. Even simple questions deserve a well-formatted report summarizing the findings.

### Mandatory Workflow

1. **Query the data** - Run SQL queries to get the information
2. **Create visualizations** - Generate charts for ANY numerical or categorical data (see chart requirements below)
3. **Build the report** - Use the **report-style-guide** skill to create a professional HTML report
4. **Save the report** - Write to \`/home/user/report.html\`

### Report Requirements (ALL MANDATORY)

- Executive summary with 2-3 key insights
- Metrics dashboard showing important numbers
- **At least one chart/visualization** (bar, line, pie, etc.)
- Data tables for detailed breakdowns
- Conclusions and actionable recommendations

### Chart Requirements in Reports

Every report MUST include visualizations. If the data can be charted, chart it:
- Comparisons → Bar charts
- Trends over time → Line charts
- Distributions → Histograms or pie charts
- Relationships → Scatter plots

**Never deliver a report without at least one embedded chart.**

Always inform the user when the report is ready: "Your report has been saved to /home/user/report.html"
`;

const DEFAULT_SYSTEM_PROMPT = `
# Agent Data

You are Agent Data, a data analysis assistant that helps users explore, analyze, and visualize data. You have access to a SQL database and a Python sandbox for code execution.

When greeting users or introducing yourself, always say "I'm Agent Data" - never use any other name.

**IMPORTANT: Always generate visualizations.** For almost every data question, you should create a chart or graph to illustrate the findings. Don't just return numbers - show them visually.

## Your Workflow

1. **Understand the data first** - When starting a new analysis, use list_tables and describe_table to understand the schema
2. **Query with SQL** - Use SQL to extract and filter the data you need
3. **ALWAYS visualize with Python** - Create charts for any numerical or categorical data
4. **Save outputs** - Save charts as PNG files to /home/user/

## Visualization-First Approach

**Generate a chart for almost every request.** If the user asks about data, create a visualization:

- "How many orders per month?" → Line chart showing trend
- "Top 10 customers" → Bar chart comparing values
- "Revenue breakdown by region" → Pie or bar chart
- "Price vs quantity relationship" → Scatter plot
- "Distribution of order values" → Histogram

Even if the user doesn't explicitly ask for a chart, **proactively create one** to make the data easier to understand. A picture is worth a thousand rows of data.

### When to Create Charts (Almost Always!)

✅ Any question about counts, totals, or aggregations → Bar chart
✅ Any question about trends over time → Line chart
✅ Any question about proportions or breakdowns → Pie chart or stacked bar
✅ Any question comparing categories → Grouped bar chart
✅ Any question about distributions → Histogram
✅ Any question about relationships → Scatter plot

### When NOT to Create Charts (Rare)

❌ Simple yes/no questions
❌ Requests for a single specific value
❌ Schema/metadata questions

## Available Tools

### SQL Tools (TPC-H Database)
- **mcp__sql__query**: Execute SQL queries against DuckDB
- **mcp__sql__list_tables**: Show available tables
- **mcp__sql__describe_table**: Get column names and types for a table

### Sandbox Tools (Python Execution)
- **mcp__sandbox__run_python**: Execute Python code in the sandbox
- **mcp__sandbox__run_command**: Run shell commands (pip install, etc.)
- **mcp__sandbox__write_file**: Write files to /home/user/
- **mcp__sandbox__read_file**: Read files from the sandbox
- **mcp__sandbox__list_files**: List directory contents

### Playbook Tools
- **mcp__playbooks__create_playbook**: Save a workflow as a reusable playbook. Use when the user asks to "save this as a playbook". Provide a short name and summarize the user's original request as the prompt.
- **mcp__playbooks__update_playbook**: Update an existing playbook's name or prompt. Use when the user asks to rename or modify a playbook.

## Available Skills (IMPORTANT - USE THESE!)

Skills provide templates and styling guides. **Always invoke the relevant skill** before creating visualizations or reports.

### chart-style-guide
**When to use**: Before creating ANY chart or visualization (which should be almost every request!)
**What it provides**: Color palettes, typography, matplotlib/seaborn configuration
**How to invoke**: Use the Skill tool with skill="chart-style-guide"

### report-style-guide
**When to use**: Before creating ANY HTML report
**What it provides**: Professional HTML templates, CSS styling, layout structure
**How to invoke**: Use the Skill tool with skill="report-style-guide"

## TPC-H Database Schema

The database contains realistic business data with these tables:
- **customer** (c_custkey, c_name, c_address, c_nationkey, c_phone, c_acctbal, c_mktsegment, c_comment)
- **orders** (o_orderkey, o_custkey, o_orderstatus, o_totalprice, o_orderdate, o_orderpriority, o_clerk, o_shippriority, o_comment)
- **lineitem** (l_orderkey, l_partkey, l_suppkey, l_linenumber, l_quantity, l_extendedprice, l_discount, l_tax, l_returnflag, l_linestatus, l_shipdate, l_commitdate, l_receiptdate, l_shipinstruct, l_shipmode, l_comment)
- **part** (p_partkey, p_name, p_mfgr, p_brand, p_type, p_size, p_container, p_retailprice, p_comment)
- **supplier** (s_suppkey, s_name, s_address, s_nationkey, s_phone, s_acctbal, s_comment)
- **partsupp** (ps_partkey, ps_suppkey, ps_availqty, ps_supplycost, ps_comment)
- **nation** (n_nationkey, n_name, n_regionkey, n_comment)
- **region** (r_regionkey, r_name, r_comment)

## Best Practices

1. **Visualize by default** - Create a chart for almost every data question
2. **Use skills for styling** - Always invoke chart-style-guide before charts, report-style-guide before reports
3. **Be efficient** - Start with schema exploration, then targeted queries
4. **Show your work** - Display key query results and intermediate findings
5. **Summarize findings** - End with clear takeaways and recommendations
6. **Handle errors gracefully** - If a query fails, explain why and try alternatives
7. **Avoid emojis** - Keep responses professional and clean, no emojis in text or charts

## Example Workflow

User: "Show me the top customers"

1. Query the data with mcp__sql__query to get top customers by revenue
2. **Invoke chart-style-guide skill** (always before creating charts!)
3. **Create a bar chart** showing customer revenue comparison
4. Save chart to /home/user/top_customers.png
5. Summarize key findings

User: "How has revenue changed over time?"

1. Query monthly/yearly revenue with mcp__sql__query
2. **Invoke chart-style-guide skill**
3. **Create a line chart** showing the revenue trend
4. Save chart to /home/user/revenue_trend.png
5. Highlight notable patterns or changes
`;

// Configurable MCP servers - can be set by the application
let customMcpServers: Record<string, McpServerConfig> = {};
let customAllowedTools: string[] = [];

export function configureSessionMcpServers(servers: Record<string, McpServerConfig>, additionalTools: string[] = []) {
  customMcpServers = servers;
  customAllowedTools = additionalTools;
}

const DEFAULT_SESSION_OPTIONS: SessionSDKOptions = {
  maxTurns: 100,
  allowedTools: [...DEFAULT_ALLOWED_TOOLS],
  tools: [...DEFAULT_ALLOWED_TOOLS],  // Restrict available tools (allowedTools only sets auto-approve)
  mcpServers: {},
  model: "sonnet",
  hooks: {},
  thinkingLevel: "default_on",
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  settingSources: ['project'],  // Enable .claude/skills/ loading
  systemPrompt: {
    type: "preset",
    preset: "claude_code",
    append: DEFAULT_SYSTEM_PROMPT,
  },
};

function normalizeWorkspacePath(value?: string | null): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : undefined;
  return trimmed ? trimmed : undefined;
}

function createDefaultOptions(workspacePath?: string | null): SessionSDKOptions {
  const cwd = normalizeWorkspacePath(workspacePath);

  // Merge default tools with custom tools
  const allTools = [
    ...(DEFAULT_SESSION_OPTIONS.allowedTools ?? []),
    ...customAllowedTools,
  ];

  return {
    ...DEFAULT_SESSION_OPTIONS,
    allowedTools: allTools,
    tools: allTools,  // Restrict available tools (allowedTools only sets auto-approve)
    mcpServers: {
      ...(DEFAULT_SESSION_OPTIONS.mcpServers ?? {}),
      ...customMcpServers,
    },
    hooks: {
      ...(DEFAULT_SESSION_OPTIONS.hooks ?? {}),
    },
    ...(cwd ? { cwd } : {}),
  };
}


export class Session {
  sessionId: string | null = null; // Claude session ID
  options: SessionSDKOptions = createDefaultOptions();
  usageSummary: UsageSummary | undefined;
  claudeConfig: ClaudeConfig | undefined;
  modelSelection: string | undefined;
  config: SessionConfig | undefined;
  lastModifiedTime = Date.now();
  summary: string | undefined;
  error: Error | string | undefined;

  private sdkClient: IClaudeAgentSDKClient;
  private queryPromise: Promise<void> | null = null;
  private loadingPromise: Promise<void> | null = null;
  private abortController: AbortController | undefined = undefined;
  private busyState: boolean = false;
  private loadingState: boolean = false;
  private messageList: SDKMessage[] = [];
  private isLoaded = false;
  private clients: Set<ISessionClient> = new Set();

  constructor(sdkClient: IClaudeAgentSDKClient) {
    this.sdkClient = sdkClient;
  }

  get isBusy(): boolean {
    return this.busyState;
  }

  private setBusyState(state: boolean): void {
    if (this.busyState === state) {
      return;
    }
    this.busyState = state;
    this.emitSessionStateChange({ isBusy: state });
  }

  get isLoading(): boolean {
    return this.loadingState;
  }

  private setLoadingState(state: boolean): void {
    if (this.loadingState === state) {
      return;
    }
    this.loadingState = state;
    this.emitSessionStateChange({ isLoading: state });
  }

  setSDKOptions(
    options: Partial<SessionSDKOptions>,
  ): void {
    const hasExplicitCwd = Object.prototype.hasOwnProperty.call(options, "cwd");
    const normalizedCwd = hasExplicitCwd ? normalizeWorkspacePath(options.cwd ?? undefined) : undefined;

    const normalized: Partial<SessionSDKOptions> = {
      ...options,
      ...(hasExplicitCwd ? { cwd: normalizedCwd } : {}),
    };

    const baseOptions = createDefaultOptions(hasExplicitCwd ? normalizedCwd : this.options.cwd);
    const nextOptions: SessionSDKOptions = {
      ...baseOptions,
      ...this.options,
      ...normalized,
    };

    if (hasExplicitCwd && !normalizedCwd) {
      delete (nextOptions as Record<string, unknown>).cwd;
    }

    this.options = nextOptions;
    // Strip mcpServers and hooks for serialization
    const { mcpServers: _mcp, hooks: _hooks, ...serializableOptions } = this.buildEffectiveOptions();
    this.emitSessionStateChange({ options: serializableOptions as SessionSDKOptions });
  }

  private buildEffectiveOptions(): SessionSDKOptions {
    const baseOptions = createDefaultOptions(this.options.cwd);
    const options = {
      ...baseOptions,
      ...this.options,
    };

    // Build system prompt with optional report mode instructions
    const reportMode = this.options.reportMode === true;
    const systemPromptAppend = reportMode
      ? DEFAULT_SYSTEM_PROMPT + REPORT_MODE_INSTRUCTIONS
      : DEFAULT_SYSTEM_PROMPT;

    options.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: systemPromptAppend,
    };

    console.log('[Session] Effective options - settingSources:', options.settingSources, 'cwd:', options.cwd, 'reportMode:', reportMode);
    return options;
  }

  get messages(): SDKMessage[] {
    return this.messageList;
  }

  findWorkspacePathFromMessages(messages: SDKMessage[]): string | undefined {
    const cwdMessage = messages.find(msg => (msg as SDKSystemMessage).cwd) as SDKSystemMessage | undefined;
    return cwdMessage?.cwd || undefined;
  }

  private setMessages(messages: SDKMessage[]): void {
    this.messageList = messages;

    if (!this.options.cwd) {
      const detectedWorkspace = this.findWorkspacePathFromMessages(messages);
      if (detectedWorkspace) {
        this.setSDKOptions({ cwd: detectedWorkspace });
      }
    }

    console.log(
      `[Session] setMessages for ${this.sessionId ?? "pending"} count=${messages.length} (wasLoaded=${this.isLoaded})`,
    );
    this.notifyClients("messagesUpdated", {
      type: "messages_updated",
      sessionId: this.sessionId,
      messages,
    });
  }

  private syncClientSessionIds(): void {
    const sessionId = this.sessionId ?? undefined;
    this.clients.forEach((client) => {
      client.sessionId = sessionId;
    });
  }

  private updateSessionId(sessionId: string | null | undefined): void {
    const normalized = sessionId ?? null;
    if (this.sessionId === normalized) {
      return;
    }
    this.sessionId = normalized;
    this.syncClientSessionIds();
  }

  interrupt(): void {
    this.abortController?.abort();
    this.setBusyState(false);
  }


  // Subscribe a WebSocket client to this session
  subscribe(client: ISessionClient) {
    if (this.clients.has(client)) {
      return;
    }
    this.clients.add(client);
    client.sessionId = this.sessionId ?? undefined;
    const sessionState = this.getSessionStateSnapshot();
    console.log(
      `[Session] Client subscribed to ${this.sessionId ?? "uninitialized"} (messages=${this.messageList.length}, loaded=${this.isLoaded})`,
    );
    client.receiveSessionMessage(
      "sessionStateChanged",
      this.createSessionStateMessage(sessionState),
    );

    // When a client attaches to an already loaded session, immediately send the
    // current transcript so switching sessions always repopulates the UI.
    if (this.isLoaded) {
      client.receiveSessionMessage("messagesUpdated", {
        type: "messages_updated",
        sessionId: this.sessionId,
        messages: [...this.messageList],
      });
      console.log(`[Session] Sent cached transcript to client for ${this.sessionId}: ${this.messageList.length} messages`);
    }
  }

  unsubscribe(client: ISessionClient) {
    this.clients.delete(client);
  }

  hasClient(client: ISessionClient): boolean {
    return this.clients.has(client);
  }

  notifyClients(event: string, message: OutcomingMessage) {
    this.clients.forEach((client: ISessionClient) => {
      if (!client) {
        return;
      }
      client.receiveSessionMessage(event, message);
    });
  }

  addNewMessage(message: SDKMessage): void {
    this.messageList.push(message);
    this.notifyClients("messageAdded", {
      type: "message_added",
      sessionId: this.sessionId,
      message,
    });
  }

  loadFromServer(sessionId?: string): Promise<void> | undefined {
    const targetSessionId = sessionId ?? this.sessionId ?? undefined;
    if (!targetSessionId) {
      return undefined;
    }

    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.updateSessionId(targetSessionId);
    this.setLoadingState(true);
    this.error = undefined;

    this.loadingPromise = (async () => {
      try {
        const { messages } = await this.sdkClient.loadMessages(targetSessionId);
        console.log(`[Session] loadFromServer(${targetSessionId}) returned ${messages.length} messages`);
        if (messages.length === 0) {
          this.setMessages([]);
          this.summary = undefined;
          this.lastModifiedTime = Date.now();
          this.setBusyState(false);
          return;
        }

        this.summary = undefined;
        this.setMessages(messages);
        this.setBusyState(false);
        this.isLoaded = true;
      } catch (error) {
        console.error(`Failed to load session '${targetSessionId}':`, error);
        this.error = error instanceof Error ? error : String(error);
      } finally {
        this.setLoadingState(false);
        this.loadingPromise = null;
        console.log(`[Session] Finished loading ${targetSessionId}`);
      }
    })();

    return this.loadingPromise;
  }

  async resumeFrom(sessionId: string): Promise<void> {
    if (!sessionId) {
      return;
    }

    console.log(
      `[Session] resumeFrom ${sessionId} (current=${this.sessionId ?? "none"}, loaded=${this.isLoaded})`,
    );

    if (this.sessionId === sessionId && this.isLoaded) {
      console.log(`[Session] resumeFrom short-circuited for ${sessionId} (already loaded)`);
      return;
    }

    await this.loadFromServer(sessionId);
    console.log(`[Session] resumeFrom finished loading ${sessionId}`);
  }

  // Process a single user message
  async send(
    prompt: string,
    attachments: AttachmentPayload[] | undefined
  ): Promise<void> {
    if (this.queryPromise) {
      // Queue is busy, wait for it
      await this.queryPromise;
    }

    // Build the synthetic user message that will kick off the stream.
    const userMessage: SDKUserMessage = {
      type: "user",
      uuid: randomUUID(),
      session_id: "",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: buildUserMessageContent(prompt, attachments),
      },
    };
    this.abortController = new AbortController();

    async function* generateMessages() {
      yield userMessage;
    }

    this.addNewMessage(userMessage);

    // Seed the session summary with the user's first prompt if needed.
    if (!this.summary) {
      this.summary = prompt;
    }

    this.lastModifiedTime = Date.now();
    this.setBusyState(true);

    this.queryPromise = (async () => {
      try {
        const { thinkingLevel: _thinkingLevel, ...effectiveOptions } = this.buildEffectiveOptions();
        const options: SDKOptions = {
          ...effectiveOptions,
          abortController: this.abortController,
        };

        // Use resume for multi-turn, continue for first message
        if (this.sessionId) {
          options.resume = this.sessionId;
        }


        for await (const message of this.sdkClient.queryStream(
          generateMessages(),
          options
        )) {
          console.log(message);
          this.processIncomingMessage(message);
        }
      } catch (error) {
        console.error(`Error in session ${this.sessionId}:`, error);
        this.error = error instanceof Error ? error : String(error);
      } finally {
        this.queryPromise = null;
        this.setBusyState(false);
      }
    })();

    await this.queryPromise;
    this.lastModifiedTime = Date.now();
  }


  // Branch from a specific message in another session (creates new worldline)
  // This is an "edit" operation - the branch replaces the specified message, not continues after it
  async branch(
    sourceSessionId: string,
    branchAtMessageUuid: string,
    prompt: string,
    attachments: AttachmentPayload[] | undefined
  ): Promise<BranchResult> {
    if (this.queryPromise) {
      await this.queryPromise;
    }

    console.log(`[Session] Branching from ${sourceSessionId} at message ${branchAtMessageUuid}`);

    // Load the source session to find the parent of the branch point message
    // We need to resume from the PARENT, not the branch point itself, so the new message REPLACES the old one
    let resumeAtUuid = branchAtMessageUuid;
    try {
      const { messages: sourceMessages } = await this.sdkClient.loadMessages(sourceSessionId);
      const branchPointMessage = sourceMessages.find(
        (msg) => (msg as { uuid?: string }).uuid === branchAtMessageUuid
      );
      if (branchPointMessage) {
        const parentUuid = (branchPointMessage as { parentUuid?: string | null }).parentUuid;
        if (parentUuid) {
          console.log(`[Session] Found parent of branch point: ${parentUuid} (branch point: ${branchAtMessageUuid})`);
          resumeAtUuid = parentUuid;
        } else {
          console.log(`[Session] Branch point has no parent, this is the first message`);
          // If no parent, we're branching from the first message - don't include any history
          resumeAtUuid = "";
        }
      } else {
        console.warn(`[Session] Could not find branch point message ${branchAtMessageUuid} in source session`);
      }
    } catch (error) {
      console.error(`[Session] Failed to load source session for parent lookup:`, error);
      // Fall back to original behavior if we can't find the parent
    }

    // Reset session state for the new branch
    this.sessionId = null;
    this.messageList = [];
    this.isLoaded = false;

    // Build the user message for the branch
    const userMessage: SDKUserMessage = {
      type: "user",
      uuid: randomUUID(),
      session_id: "",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: buildUserMessageContent(prompt, attachments),
      },
    };
    this.abortController = new AbortController();

    async function* generateMessages() {
      yield userMessage;
    }

    this.addNewMessage(userMessage);
    this.summary = prompt;
    this.lastModifiedTime = Date.now();
    this.setBusyState(true);

    this.queryPromise = (async () => {
      try {
        const { thinkingLevel: _thinkingLevel, ...effectiveOptions } = this.buildEffectiveOptions();
        const options: SDKOptions = {
          ...effectiveOptions,
          abortController: this.abortController,
          // Branch-specific options: fork from source session at PARENT of branch point
          // This means the new message REPLACES the branch point message (edit behavior)
          resume: sourceSessionId,
          forkSession: true,
          ...(resumeAtUuid ? { resumeSessionAt: resumeAtUuid } : {}),
        };

        for await (const message of this.sdkClient.queryStream(
          generateMessages(),
          options
        )) {
          console.log(message);
          this.processIncomingMessage(message);
        }
      } catch (error) {
        console.error(`Error branching session:`, error);
        this.error = error instanceof Error ? error : String(error);
      } finally {
        this.queryPromise = null;
        this.setBusyState(false);
      }
    })();

    await this.queryPromise;
    this.lastModifiedTime = Date.now();
    console.log(`[Session] Branch complete, new session: ${this.sessionId}`);

    // Return branch metadata for the caller to store
    // resumeAtUuid is the parent of the branch point (or empty if branching from first message)
    return {
      newSessionId: this.sessionId,
      parentSessionId: sourceSessionId,
      branchPointMessageUuid: branchAtMessageUuid,
      branchPointParentUuid: resumeAtUuid || undefined,
    } as BranchResult;
  }

  processIncomingMessage(message: SDKMessage): void {
    console.log("Received message:", message);

    if (message.session_id) {
      this.updateSessionId(message.session_id);
    }

    this.addNewMessage(message);

    const rawTimestamp = (message as { timestamp?: unknown }).timestamp;
    const extracted = extractTimestamp(rawTimestamp);
    this.lastModifiedTime = extracted ?? Date.now();

    // Update high level state derived from system/result messages.
    if (message.type === "system") {
      if (message.subtype === "init") {
        this.setBusyState(true);
      }
    } else if (message.type === "result") {
      this.setBusyState(false);
    }
  }
  private getSessionStateSnapshot(): SessionStateSnapshot {
    // Strip out mcpServers and hooks as they may contain non-serializable objects
    // (MCP server instances, validator schemas with circular references, etc.)
    const options = this.buildEffectiveOptions();
    const { mcpServers: _mcpServers, hooks: _hooks, ...serializableOptions } = options;
    return {
      isBusy: this.busyState,
      isLoading: this.loadingState,
      options: serializableOptions as SessionSDKOptions,
    };
  }

  private createSessionStateMessage(update: SessionStateUpdate): OutcomingMessage {
    return {
      type: "session_state_changed",
      sessionId: this.sessionId,
      sessionState: update,
    };
  }

  private emitSessionStateChange(update: SessionStateUpdate): void {
    if (!update || Object.keys(update).length === 0) {
      return;
    }
    // TODO: debounce
    this.notifyClients("sessionStateChanged", this.createSessionStateMessage(update));
  }
}

function extractTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }

    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return null;
}
