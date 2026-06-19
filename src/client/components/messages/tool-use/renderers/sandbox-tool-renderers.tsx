import { DatabaseIcon, CodeIcon, FileIcon, FolderIcon, TerminalIcon, BookmarkIcon, GitBranchIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { ToolResultContentBlock } from "@claude-agent-kit/messages";
import type { ClaudeMessageContext } from "../../types";
import { BaseToolRenderer } from "./base-tool-renderer";
import type { ToolInput } from "./utils";
import { toDisplayText } from "./utils";

export class SqlQueryRenderer extends BaseToolRenderer {
  constructor() {
    super("SQL Query");
  }

  header(_context: ClaudeMessageContext, input: ToolInput): ReactNode {
    const query = (input as { query?: string }).query || "";
    // Extract table name from query if possible
    const tableMatch = query.match(/from\s+(\w+)/i);
    const tableName = tableMatch ? tableMatch[1] : undefined;

    return (
      <span className="inline-flex items-center gap-2">
        <DatabaseIcon className="size-4 text-blue-500" />
        <span className="font-medium">SQL Query</span>
        {tableName && (
          <>
            <span className="text-muted-foreground">•</span>
            <span className="text-muted-foreground">{tableName}</span>
          </>
        )}
      </span>
    );
  }

  protected computeResultSummary(result: ToolResultContentBlock | undefined): string | undefined {
    if (!result) return undefined;
    const text = toDisplayText(result);
    if (!text) return undefined;

    // Try to count rows in the result
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return `${parsed.length} row${parsed.length !== 1 ? 's' : ''}`;
      }
    } catch {
      // Count newlines as approximation for rows
      const lines = text.split('\n').filter(l => l.trim()).length;
      if (lines > 0) {
        return `${lines} row${lines !== 1 ? 's' : ''}`;
      }
    }
    return undefined;
  }
}

export class PythonRenderer extends BaseToolRenderer {
  constructor() {
    super("Python");
  }

  header(_context: ClaudeMessageContext, _input: ToolInput): ReactNode {
    return (
      <span className="inline-flex items-center gap-2">
        <CodeIcon className="size-4 text-yellow-600" />
        <span className="font-medium">Python</span>
      </span>
    );
  }

  protected computeResultSummary(result: ToolResultContentBlock | undefined): string | undefined {
    if (!result) return undefined;
    const text = toDisplayText(result);
    if (!text) return undefined;

    // Count output lines
    const lines = text.split('\n').filter(l => l.trim()).length;
    if (lines > 0) {
      return `${lines} output${lines !== 1 ? 's' : ''}`;
    }
    return undefined;
  }
}

export class SandboxCommandRenderer extends BaseToolRenderer {
  constructor() {
    super("Command");
  }

  header(_context: ClaudeMessageContext, input: ToolInput): ReactNode {
    const cmd = (input as { command?: string }).command || "";
    const cmdName = cmd.split(' ')[0] || "command";

    return (
      <span className="inline-flex items-center gap-2">
        <TerminalIcon className="size-4 text-gray-600" />
        <span className="font-medium">{cmdName}</span>
      </span>
    );
  }
}

export class SandboxWriteFileRenderer extends BaseToolRenderer {
  constructor() {
    super("Write File");
  }

  header(_context: ClaudeMessageContext, input: ToolInput): ReactNode {
    const path = (input as { path?: string }).path || "";
    const fileName = path.split('/').pop() || path;

    return (
      <span className="inline-flex items-center gap-2">
        <FileIcon className="size-4 text-green-600" />
        <span className="font-medium">Write</span>
        <span className="text-muted-foreground">•</span>
        <span className="text-muted-foreground font-mono text-xs">{fileName}</span>
      </span>
    );
  }

  protected computeResultSummary(result: ToolResultContentBlock | undefined): string | undefined {
    if (!result) return undefined;
    const text = toDisplayText(result);
    if (!text) return undefined;

    // Extract bytes written
    const bytesMatch = text.match(/(\d+)\s*bytes/i);
    if (bytesMatch) {
      const bytes = parseInt(bytesMatch[1], 10);
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    return "saved";
  }
}

export class SandboxReadFileRenderer extends BaseToolRenderer {
  constructor() {
    super("Read File");
  }

  header(_context: ClaudeMessageContext, input: ToolInput): ReactNode {
    const path = (input as { path?: string }).path || "";
    const fileName = path.split('/').pop() || path;

    return (
      <span className="inline-flex items-center gap-2">
        <FileIcon className="size-4 text-blue-500" />
        <span className="font-medium">Read</span>
        <span className="text-muted-foreground">•</span>
        <span className="text-muted-foreground font-mono text-xs">{fileName}</span>
      </span>
    );
  }
}

export class SandboxListFilesRenderer extends BaseToolRenderer {
  constructor() {
    super("List Files");
  }

  header(_context: ClaudeMessageContext, input: ToolInput): ReactNode {
    const path = (input as { path?: string }).path || "/sandbox/files";
    const dirName = path.split('/').pop() || path;

    return (
      <span className="inline-flex items-center gap-2">
        <FolderIcon className="size-4 text-yellow-500" />
        <span className="font-medium">List</span>
        <span className="text-muted-foreground">•</span>
        <span className="text-muted-foreground font-mono text-xs">{dirName}</span>
      </span>
    );
  }

  protected computeResultSummary(result: ToolResultContentBlock | undefined): string | undefined {
    if (!result) return undefined;
    const text = toDisplayText(result);
    if (!text) return undefined;

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return `${parsed.length} item${parsed.length !== 1 ? 's' : ''}`;
      }
    } catch {
      // Ignore
    }
    return undefined;
  }
}

export class SqlListTablesRenderer extends BaseToolRenderer {
  constructor() {
    super("List Tables");
  }

  header(_context: ClaudeMessageContext, _input: ToolInput): ReactNode {
    return (
      <span className="inline-flex items-center gap-2">
        <DatabaseIcon className="size-4 text-blue-500" />
        <span className="font-medium">List Tables</span>
      </span>
    );
  }
}

export class SqlDescribeTableRenderer extends BaseToolRenderer {
  constructor() {
    super("Describe Table");
  }

  header(_context: ClaudeMessageContext, input: ToolInput): ReactNode {
    const table = (input as { table?: string }).table || "";

    return (
      <span className="inline-flex items-center gap-2">
        <DatabaseIcon className="size-4 text-blue-500" />
        <span className="font-medium">Describe</span>
        {table && (
          <>
            <span className="text-muted-foreground">•</span>
            <span className="text-muted-foreground">{table}</span>
          </>
        )}
      </span>
    );
  }
}

export class PlaybookCreateRenderer extends BaseToolRenderer {
  constructor() {
    super("Create Playbook");
  }

  header(_context: ClaudeMessageContext, input: ToolInput): ReactNode {
    const name = (input as { name?: string }).name || "";

    return (
      <span className="inline-flex items-center gap-2">
        <BookmarkIcon className="size-4 text-purple-500" />
        <span className="font-medium">Save Playbook</span>
        {name && (
          <>
            <span className="text-muted-foreground">•</span>
            <span className="text-muted-foreground">{name}</span>
          </>
        )}
      </span>
    );
  }

  protected computeResultSummary(): string | undefined {
    return "saved";
  }
}

export class PlaybookUpdateRenderer extends BaseToolRenderer {
  constructor() {
    super("Update Playbook");
  }

  header(_context: ClaudeMessageContext, input: ToolInput): ReactNode {
    const currentName = (input as { current_name?: string }).current_name || "";
    const newName = (input as { new_name?: string }).new_name;

    return (
      <span className="inline-flex items-center gap-2">
        <BookmarkIcon className="size-4 text-purple-500" />
        <span className="font-medium">Update Playbook</span>
        {(newName || currentName) && (
          <>
            <span className="text-muted-foreground">•</span>
            <span className="text-muted-foreground">{newName || currentName}</span>
          </>
        )}
      </span>
    );
  }

  protected computeResultSummary(): string | undefined {
    return "updated";
  }
}

export class WorldlineCreateRenderer extends BaseToolRenderer {
  constructor() {
    super("Create Worldline");
  }

  header(_context: ClaudeMessageContext, input: ToolInput): ReactNode {
    const direction = (input as { new_direction?: string }).new_direction || "";
    // Truncate long directions
    const shortDirection = direction.length > 40 ? direction.slice(0, 40) + "…" : direction;

    return (
      <span className="inline-flex items-center gap-2">
        <GitBranchIcon className="size-4 text-emerald-500" />
        <span className="font-medium">Branch</span>
        {shortDirection && (
          <>
            <span className="text-muted-foreground">•</span>
            <span className="text-muted-foreground text-xs">{shortDirection}</span>
          </>
        )}
      </span>
    );
  }

  protected computeResultSummary(): string | undefined {
    return "switching";
  }
}
