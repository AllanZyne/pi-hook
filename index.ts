import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "hooks.json");
const DEFAULT_TIMEOUT_SECONDS = 10;

const EVENT_NAMES = [
  "project_trust",
  "resources_discover",
  "session_start",
  "session_info_changed",
  "session_before_switch",
  "session_before_fork",
  "session_before_compact",
  "session_compact",
  "session_compact_failed",
  "session_shutdown",
  "session_before_tree",
  "session_tree",
  "context",
  "before_provider_request",
  "before_provider_headers",
  "after_provider_response",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "agent_settled",
  "ui_prompt_start",
  "ui_prompt_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "model_select",
  "thinking_level_select",
  "tool_call",
  "tool_result",
  "user_bash",
  "input",
] as const;

type EventName = (typeof EVENT_NAMES)[number];

type HookDefinition = {
  command: string;
  timeout?: number;
};

type HookConfig = Partial<Record<EventName, HookDefinition[]>>;

type HookResult = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
};

function loadConfig(): HookConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    console.warn(`[pi-hook] Cannot read ${CONFIG_PATH}: ${String(error)}`);
    return {};
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    console.warn(`[pi-hook] ${CONFIG_PATH} must contain a JSON object`);
    return {};
  }

  const supported = new Set<string>(EVENT_NAMES);
  const config: HookConfig = {};
  for (const [eventName, definitions] of Object.entries(value)) {
    if (!supported.has(eventName)) {
      console.warn(`[pi-hook] Ignoring unsupported event: ${eventName}`);
      continue;
    }
    if (!Array.isArray(definitions)) {
      console.warn(`[pi-hook] Ignoring ${eventName}: value must be an array`);
      continue;
    }

    const valid = definitions.filter((definition): definition is HookDefinition => {
      if (!definition || typeof definition !== "object") return false;
      const candidate = definition as Record<string, unknown>;
      return (
        typeof candidate.command === "string" &&
        candidate.command.trim().length > 0 &&
        (candidate.timeout === undefined ||
          (typeof candidate.timeout === "number" &&
            Number.isFinite(candidate.timeout) &&
            candidate.timeout > 0))
      );
    });

    if (valid.length !== definitions.length) {
      console.warn(`[pi-hook] Ignoring invalid command entries for ${eventName}`);
    }
    if (valid.length > 0) config[eventName as EventName] = valid;
  }
  return config;
}

function jsonPayload(eventName: EventName, event: unknown, ctx: ExtensionContext): string {
  const seen = new WeakSet<object>();
  const eventFields = event && typeof event === "object" ? event : {};
  // project_trust has a deliberately limited context without sessionManager.
  const sessionManager = (ctx as Partial<ExtensionContext>).sessionManager;
  const payload = {
    event_name: eventName,
    cwd: ctx.cwd,
    session_id: sessionManager?.getSessionId(),
    transcript_path: sessionManager?.getSessionFile(),
    ...(eventFields as Record<string, unknown>),
    // Compatibility for scripts that expect a prompt field.
    ...(eventName === "input" && "text" in (eventFields as object)
      ? { prompt: (eventFields as { text: unknown }).text }
      : {}),
  };

  return JSON.stringify(payload, (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  });
}

function runCommand(definition: HookDefinition, stdin: string): Promise<HookResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", definition.command], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: definition.command,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        timedOut,
      });
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));

    const timeoutMs = (definition.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 500).unref();
    }, timeoutMs);
    timer.unref();

    child.stdin.end(stdin);
  });
}

function outputMessage(result: HookResult): string | undefined {
  if (result.timedOut) {
    console.warn(`[pi-hook] Timed out: ${result.command}`);
  } else if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    console.warn(
      `[pi-hook] Command exited ${result.exitCode ?? "with an error"}: ${result.command}` +
        (detail ? `\n${detail}` : ""),
    );
  }

  const output = result.stdout.trim();
  if (!output) return undefined;

  // Compatibility with Claude command hooks such as english-block.sh. Return
  // the UI-only message to the caller; it is never added to model context.
  try {
    const parsed = JSON.parse(output) as { systemMessage?: unknown };
    if (typeof parsed.systemMessage === "string" && parsed.systemMessage.length > 0) {
      return parsed.systemMessage;
    }
  } catch {
    // Generic hook stdout is intentionally ignored. Hooks can write directly
    // to their target tty when they need side effects such as BEL.
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const pendingInputOutput: string[][] = [];
  const on = pi.on.bind(pi) as unknown as (
    event: EventName,
    handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>,
  ) => void;

  for (const eventName of EVENT_NAMES) {
    const definitions = config[eventName];
    if (!definitions?.length) continue;

    on(eventName, async (event, ctx) => {
      // `input` is reserved for text typed by the human in the TUI. RPC input
      // and extension-injected messages (e.g. pi.sendUserMessage()) deliberately
      // do not run input hooks. They still produce a real user-role message and
      // thus a matching `message_start` below, so we must still push a (empty)
      // entry here to keep pendingInputOutput aligned 1:1 with message_start.
      // Returning early without pushing would let message_start's shift() steal
      // the entry queued for a later, genuinely interactive message, causing the
      // hook output to permanently drift and show the previous turn's result.
      if (
        eventName === "input" &&
        (!event || typeof event !== "object" ||
          (event as { source?: unknown }).source !== "interactive")
      ) {
        pendingInputOutput.push([]);
        return;
      }

      const payload = jsonPayload(eventName, event, ctx);
      const messages: string[] = [];
      for (const definition of definitions) {
        const message = outputMessage(await runCommand(definition, payload));
        if (message !== undefined) messages.push(message);
      }

      if (eventName === "input") {
        // Pair output with the next user message emitted by the session. This
        // also preserves queued steer/follow-up ordering.
        pendingInputOutput.push(messages);
      } else {
        for (const message of messages) ctx.ui.notify(message, "info");
      }

      // project_trust requires every participating handler to explicitly
      // defer or decide. Hooks are observational, so always defer.
      if (eventName === "project_trust") return { trusted: "undecided" };
    });
  }

  // Extension handlers run before AgentSession notifies the TUI. Waiting one
  // event-loop phase lets the user message render first; the hook output then
  // uses pi's ordinary status presentation immediately below it.
  on("message_start", async (event, ctx) => {
    if (
      !event ||
      typeof event !== "object" ||
      (event as { message?: { role?: unknown } }).message?.role !== "user"
    ) {
      return;
    }

    const messages = pendingInputOutput.shift();
    if (!messages?.length) return;
    setImmediate(() => {
      for (const message of messages) {
        // Claude hooks often prefix systemMessage with one newline to separate
        // it from Claude's hook label. Pi status already inserts a spacer, so
        // drop only that first newline to avoid a double-sized gap.
        ctx.ui.notify(message.replace(/^\r?\n/, ""), "info");
      }
    });
  });
}
