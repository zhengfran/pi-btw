# pi-btw

Read-only side conversations for [Pi](https://pi.dev), with breakout into independent Herdr sessions.

## Why another pi-btw?

I wanted to **turn a BTW thread into an independent Herdr session**, carrying its
context and full discussion into a new tab so I can continue working there.
None of the BTW packages I researched met that need.

## Prerequisites

- **Herdr**, with Pi running inside it and the `herdr` CLI available.
- **Pi** in interactive terminal mode (verified with 1.4.0).
- **Node.js 22.19+**.

## Install

```sh
pi install git:github.com/zhengfran/pi-btw
```

Run `/reload` if Pi is already open.

## Usage

| Command | Action |
| --- | --- |
| `/btw <question>` | Start a side thread |
| `/btw` | Reopen the selected thread, or create one |
| `/btws` | Select a saved thread |
| `/btw-breakout [id]` | Open a thread as an independent Pi session in a new Herdr tab |

Inside the popup:

- **Enter:** send a follow-up; **PgUp/PgDn:** scroll.
- **Ctrl+N:** new thread; **Ctrl+T:** switch threads.
- **Ctrl+B:** break out the thread after its answer finishes.
- **Esc:** close the popup and keep the thread; generation continues.
- **Ctrl+C:** cancel generation, delete the thread, and close the popup.

## Behaviour

BTW shares the project/branch footer line; other extensions' statuses stay visible.
It uses Pi's custom footer while threads exist, so avoid other footer replacements.

Threads inherit the main conversation's context and can inspect files using
`read`, `grep`, `find`, and `ls`. They cannot edit files or run shell commands,
and their answers stay out of the main agent's context. File access is not an
OS sandbox; side requests incur their own model costs.

Breakout copies the context and discussion into a new session with normal Pi
tools, then opens and focuses its Herdr tab. The main session and original side
thread are unchanged. Deleting a side thread does not delete its breakout sessions.

## Development

```sh
npm ci
npm run check
npm run format:check
pi -e ./src/index.ts
```

## License

[MIT](LICENSE).
