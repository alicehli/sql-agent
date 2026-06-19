"use client";

import { CodeBlock } from "@/components/messages/code-block";
import { cn } from "@/lib/utils";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

import type { ToolResultContentBlock } from "@claude-agent-kit/messages";
import type { ClaudeMessageContext } from "../../types";
import {
  isNonEmptyRecord,
  stringifyInput,
  toDisplayText,
} from "./utils";
import type { ToolInput as ToolInputData } from "./utils";

export type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error";

export const getStatusBadge = (status: ToolState) => {
  // Simple colored dot based on status
  const dotColors: Record<ToolState, string> = {
    "input-streaming": "bg-gray-400",
    "input-available": "bg-yellow-500 animate-pulse",
    "output-available": "bg-green-500",
    "output-error": "bg-red-500",
  };

  return (
    <span className={cn("inline-block size-2 rounded-full", dotColors[status])} />
  );
};

export type ToolInputProps = ComponentProps<"div"> & {
  input: Record<string, unknown>;
  onOpen?: () => void;
};

export const ToolInput = ({
  className,
  input,
  onOpen,
  ...props
}: ToolInputProps) => {
  const json = stringifyInput(input);

  return (
    <div
      className={cn("flex flex-col gap-2 text-sm text-muted-foreground", className)}
      {...props}
    >
      <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        <span>
          Parameters
        </span>
        {onOpen ? (
          <button
            type="button"
            className="text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
          >
            Open
          </button>
        ) : null}
      </div>
      <CodeBlock code={json} language="json" className="text-left text-xs" />
    </div>
  );
};

export type ToolOutputProps = ComponentProps<"div"> & {
  output?: unknown;
  errorText?: ReactNode;
  language?: string;
  onOpen?: () => void;
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  language = "bash",
  onOpen,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let outputNode: ReactNode = null;

  if (typeof output === "string") {
    outputNode = <CodeBlock code={output} language={language} className="text-left text-xs" />;
  } else if (
    output &&
    typeof output === "object" &&
    !isValidElement(output)
  ) {
    outputNode = (
      <CodeBlock
        code={JSON.stringify(output, null, 2)}
        language="json"
        className="text-left text-xs"
      />
    );
  } else if (output) {
    outputNode = output as ReactNode;
  }

  const errorNode =
    typeof errorText === "string" ? (
      <pre className="whitespace-pre-wrap text-xs font-mono text-destructive">
        {errorText}
      </pre>
    ) : (
      errorText
    );

  return (
    <div
      className={cn("flex flex-col gap-2 text-sm text-muted-foreground", className)}
      {...props}
    >
      <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        <h4 className="text-xs font-medium uppercase tracking-wide">
          {errorText ? "Error" : "Result"}
        </h4>
        {onOpen ? (
          <button
            type="button"
            className="text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
          >
            Open
          </button>
        ) : null}
      </div>
      {errorText ? (
        errorNode
      ) : (
        outputNode
      )}
    </div>
  );
};

export abstract class BaseToolRenderer {
  constructor(protected readonly name: string) {}

  header(_context: ClaudeMessageContext, _input: ToolInputData): ReactNode {
    return <span className="font-semibold">{this.name}</span>;
  }

  body(
    context: ClaudeMessageContext,
    input: ToolInputData,
    result: ToolResultContentBlock | undefined,
  ): ReactNode {
    const sections: ReactNode[] = [];

    const description = this.toolDescription(input, result);
    if (description) {
      sections.push(description);
    }

    const inputSection = this.renderInput(context, input);
    if (inputSection) {
      sections.push(inputSection);
    }

    const outputSection = this.renderOutput(context, result);
    if (outputSection) {
      sections.push(outputSection);
    }

    if (sections.length === 0) {
      return null;
    }

    return (
      <div className="flex flex-col gap-4 text-sm text-foreground">
        {sections.map((section, index) => (
          <div key={`section-${index}`}>{section}</div>
        ))}
      </div>
    );
  }

  getState(result: ToolResultContentBlock | undefined): ToolState {
    return this.getToolState(result);
  }

  getResultSummary(result: ToolResultContentBlock | undefined): string | undefined {
    return this.computeResultSummary(result);
  }

  protected computeResultSummary(_result: ToolResultContentBlock | undefined): string | undefined {
    return undefined;
  }

  protected getToolState(result: ToolResultContentBlock | undefined): ToolState {
    if (result?.is_error) {
      return "output-error";
    }
    if (result) {
      return "output-available";
    }
    return "input-available";
  }

  protected renderInput(
    context: ClaudeMessageContext,
    input: ToolInputData,
  ): ReactNode | undefined {
    if (!isNonEmptyRecord(input)) {
      return undefined;
    }

    const content = stringifyInput(input);
    const handleOpen = () =>
      context.fileOpener.openContent(
        content,
        `${this.name} tool input`,
        false,
      );

    return <ToolInput key="input" input={input} onOpen={handleOpen} />;
  }

  protected renderOutput(
    context: ClaudeMessageContext,
    result: ToolResultContentBlock | undefined,
  ): ReactNode | undefined {
    const rawOutput = toDisplayText(result);
    const { output, errorText } = this.getOutputPayload(result, rawOutput);

    if (!output && !errorText) {
      return undefined;
    }

    const handleOpen =
      rawOutput === undefined
        ? undefined
        : () =>
            context.fileOpener.openContent(
              rawOutput,
              `${this.name} tool output`,
              false,
            );

    return (
      <ToolOutput
        key="output"
        output={output}
        errorText={errorText}
        language={this.getOutputLanguage(result)}
        onOpen={handleOpen}
      />
    );
  }

  protected getOutputLanguage(
    _result: ToolResultContentBlock | undefined,
  ): string {
    return "bash";
  }

  protected getOutputPayload(
    result: ToolResultContentBlock | undefined,
    rawOutput: string | undefined,
  ): { output?: unknown; errorText?: string } {
    if (!rawOutput) {
      return {};
    }

    if (result?.is_error) {
      return { errorText: rawOutput };
    }

    return { output: rawOutput };
  }

  protected toolDescription(
    _input: ToolInputData,
    _result: ToolResultContentBlock | undefined,
  ): ReactNode | undefined {
    return undefined;
  }
}
