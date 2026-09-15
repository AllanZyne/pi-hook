# pi-hook

Run shell commands when native pi extension events fire.

## Installation

```bash
git clone https://github.com/AllanZyne/pi-hook.git ~/.pi/agent/extensions/hook
```

Restart pi, or run `/reload` in an existing session.

## Configuration

Create `~/.pi/agent/hooks.json`. The top-level keys are native pi event names; each value is an ordered list of commands:

```json
{
  "agent_settled": [
    { "command": "~/.claude/hooks/notify.sh 1" }
  ],
  "ui_prompt_start": [
    { "command": "~/.claude/hooks/notify.sh 2" }
  ],
  "input": [
    { "command": "~/.claude/hooks/english-block.sh", "timeout": 10 }
  ]
}
```

`timeout` is in seconds and defaults to 10. Commands for one event run sequentially in configuration order through `/bin/bash -lc`.

The configuration is loaded when the extension loads. Run `/reload` after editing it.

## Command input

Each command receives one JSON object on stdin. Event properties stay at the top level, with these common fields added:

- `event_name`: native pi event name
- `cwd`: current working directory
- `session_id`: current pi session ID
- `transcript_path`: current session file
- `prompt`: alias of `text`, provided only for `input` compatibility

Example input payload:

```json
{
  "event_name": "input",
  "type": "input",
  "text": "Explain this code",
  "prompt": "Explain this code",
  "source": "interactive",
  "cwd": "/work/project",
  "session_id": "...",
  "transcript_path": "..."
}
```

`input` hooks intentionally run only when `event.source` is `interactive`. RPC input and messages injected by extensions are skipped, so programmatic messages and sub-agent activity cannot masquerade as human input.

Hook output does not alter, block, or add context to pi. For compatibility with an existing Claude command hook, stdout shaped as `{ "systemMessage": "..." }` is rendered using pi's ordinary status presentation. For an `input` hook, the output is deferred until its user message has rendered, so it appears immediately below that message and above the assistant response. Pi removes at most one leading newline because status already supplies its own spacer; all remaining content and ANSI styling are preserved. Other stdout is ignored. Nonzero exits and timeouts are logged but do not interrupt pi.

## Supported events

- Startup/resources: `project_trust`, `resources_discover`
- Session: `session_start`, `session_info_changed`, `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_compact`, `session_compact_failed`, `session_shutdown`, `session_before_tree`, `session_tree`
- Agent/UI: `before_agent_start`, `agent_start`, `agent_end`, `agent_settled`, `ui_prompt_start`, `ui_prompt_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`
- Provider/context: `context`, `before_provider_headers`, `before_provider_request`, `after_provider_response`
- Tools: `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `tool_call`, `tool_result`, `user_bash`
- Model/input: `model_select`, `thinking_level_select`, `input`

This extension treats every hook as observational. It intentionally does not implement event-specific return values such as blocking `tool_call`, transforming `input`, changing `context`, or deciding `project_trust`.
