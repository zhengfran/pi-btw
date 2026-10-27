# pi-btw

Persistent read-only side conversations for [Pi](https://pi.dev), with a bordered
popup, streaming answers, a native working spinner, and independent session breakout.

## Install

```sh
pi install git:github.com/zhengfran/pi-btw
```

Run `/reload` in an existing Pi instance. Requires Node.js 22.19 or newer and
interactive terminal mode. Verified with Pi 1.4.0. Herdr is optional; it is only
used to open breakout sessions in new tabs.

To try it without adding it to settings:

```sh
pi -e git:github.com/zhengfran/pi-btw
```

## How it works

An interactive Pi extension for multiple persistent side threads. Each new thread
starts from a snapshot of the main conversation's current branch, including its
compaction state. It does not interrupt the main agent or send side answers into
its context. If the main agent is midway through a tool call, the snapshot stops
before that incomplete assistant turn.

## Commands

| Command | Action |
| --- | --- |
| `/btw <question>` | Start a new side thread and ask immediately |
| `/btw` | Reopen the selected thread, or create an empty one |
| `/btws` | Select and resume one of this session branch's threads |
| `/btw-breakout [id]` | Open the selected/named thread as an independent Pi session in a new Herdr tab |

The package exposes `src/index.ts` through its Pi manifest. Do not load an older
local copy alongside this package: both register the same commands. Existing BTW
threads use the same storage and can be resumed after migrating.

## Inside the overlay

- **Enter:** send a follow-up in this thread after the current answer finishes.
- **Page Up / Page Down:** scroll the conversation.
- **Ctrl+N:** start a separate thread from the current main conversation.
- **Ctrl+T:** switch threads, including ones still answering.
- **Ctrl+B:** open this thread in a new Herdr tab once it is idle.
- **Ctrl+C:** cancel generation, delete this thread and its saved transcript, and close the overlay. This does not stop the main agent or delete independent breakout sessions.
- **Escape:** close the overlay and keep the thread for `/btws`; an in-flight answer continues in the background.

The popup has a visible rounded border. Answers stream into it, and Pi's native
working spinner animates while the thread is busy, including during file
inspection. The spinner stops when the request finishes or the overlay closes.
The status bar shows the thread count and number still working.

## Read-only scope

Side agents have exactly four built-in tools: **read, grep, find, ls**. Shell,
editing, writing, skills, prompt templates, other extensions, and their lifecycle
hooks are not loaded into the side agent. Custom model-provider registrations
are copied separately so provider-backed models remain usable.

This is a tool allowlist, not an OS sandbox: allowed tools can inspect files the
Pi process can read. Like ordinary Pi requests, their results are sent to the
chosen model provider. Side requests have their own model calls and token costs;
do not assume they share the main conversation's prompt cache.

Each thread keeps its initial context snapshot plus its own follow-ups. It does
not continuously import new main-agent messages or other side threads. Model and
thinking level are inherited at creation. Thread transcripts are saved under
`$PI_CODING_AGENT_DIR/btw/<parent-session-id>/` (normally `~/.pi/agent/btw/`).
Only thread references are appended to the main session as custom metadata;
side prompts and answers are not inserted into its model conversation. Saved
references are restored from the active main branch on resume or reload.

## Breakout

Breakout creates a **new saved session ID** in Pi's ordinary session directory,
with the main-context snapshot and the entire side discussion, including tool
results. In Herdr, it creates a tab in the calling workspace and project directory,
starts Pi there with the saved session, and focuses that tab once Pi is ready.
`/btw-breakout ` followed by **Tab** completes thread IDs, showing their titles.

Outside Herdr, it prints a shell-quoted command to run in another terminal:

```sh
cd '/path/to/project' && pi --session '/path/to/new-session.jsonl'
```

This is a copy, not a move or merge: the main session and original side thread
remain unchanged, and the original thread remains read-only. The new session is
an ordinary Pi session with the normal tools and extensions configured there.
A busy thread must finish before breakout. Threads can resume in
read-only mode without breaking out. If Herdr launch fails, the error includes
the saved session command and any created tab ID; it does not retry or close
the tab, since the agent may already have started.

## Development

```sh
npm ci
npm run check
npm run format:check
pi -e ./src/index.ts
```

Pi provides the runtime APIs; development dependencies are for type-checking only.
The package does not bundle a second Pi runtime or require a build step.

## License

[MIT](LICENSE).
