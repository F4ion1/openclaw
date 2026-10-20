import { describe, expect, it } from "vitest";
import { buildCommandOutputFromToolResultEvent } from "./agent-runner-command-output.js";

const BASH_ARGS = { command: "nope-not-a-command", description: "run missing binary" };

function buildFromCliResult(overrides: Record<string, unknown>) {
  return buildCommandOutputFromToolResultEvent({
    stream: "tool",
    data: { phase: "result", name: "Bash", toolCallId: "call-1", args: BASH_ARGS, ...overrides },
  });
}

function expectResult(data: Record<string, unknown>, expected: Record<string, unknown>) {
  expect(buildFromCliResult(data)).toMatchObject(expected);
}

describe("buildCommandOutputFromToolResultEvent", () => {
  it.each(["exec", "mcp__openclaw__exec", "mcp_openclaw_exec"])(
    "preserves the authored title and raw identity for %s",
    (name) => {
      expectResult(
        {
          name,
          commandBearing: true,
          args: { command: "false", title: "Check build status" },
          isError: true,
          result: "command failed",
        },
        {
          name,
          toolCallId: "call-1",
          title: "Check build status",
          status: "failed",
          output: "command failed",
        },
      );
    },
  );

  it.each([
    { name: "mcp__other__exec", commandBearing: true, title: undefined, expected: "false" },
    { name: "mcp__openclaw__exec", title: "Recorded title", expected: "Recorded title" },
  ])("keeps explicit titles and third-party names unchanged: $name", ({ expected, ...data }) => {
    expectResult(
      {
        commandBearing: true,
        args: { command: "false", title: "Check build status" },
        isError: true,
        result: "command failed",
        ...data,
      },
      { name: data.name, title: expected, status: "failed" },
    );
  });

  it("reports a CLI command failure whose result is only text", () => {
    // CLI backends report the outcome plus raw content, never a structured
    // record, so requiring a structured field dropped the failure entirely.
    expectResult(
      { isError: true, result: "bash: nope-not-a-command: command not found" },
      {
        status: "failed",
        output: "bash: nope-not-a-command: command not found",
        title: expect.stringContaining("nope-not-a-command"),
      },
    );
  });

  it("reads the outcome from streamed text blocks", () => {
    expectResult(
      {
        isError: true,
        result: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      },
      { status: "failed", output: "line one\nline two" },
    );
  });

  it("projects a safe terminal state from a namespaced command-bearing result", () => {
    expectResult(
      { name: "server.exec", args: undefined, commandBearing: true, isError: false },
      { name: "server.exec", status: "completed", toolCallId: "call-1" },
    );
  });

  it("prefers an explicit status and structured fields when present", () => {
    expectResult(
      {
        name: "exec",
        args: undefined,
        title: "false",
        isError: true,
        result: { exitCode: 2, output: "structured output", status: "exit 2" },
      },
      { status: "exit 2", exitCode: 2, output: "structured output", title: "false" },
    );
  });

  it("ignores events that carry no outcome and no content", () => {
    expect(buildFromCliResult({ args: undefined })).toBeUndefined();
  });

  it("ignores non-command tools and non-result phases", () => {
    expect(buildFromCliResult({ name: "Read", args: undefined, isError: true })).toBeUndefined();
    expect(buildFromCliResult({ phase: "start", isError: true })).toBeUndefined();
  });
});
