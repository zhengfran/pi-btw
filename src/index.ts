import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { showThread } from "./overlay.ts";
import {
  breakOut,
  createThread,
  DELETE_ENTRY,
  openThread,
  removeThreadFile,
  resumeCommand,
  THREAD_ENTRY,
  type Thread,
  type ThreadInfo,
} from "./session.ts";

function isThreadInfo(value: unknown): value is ThreadInfo {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data.id === "string" &&
    typeof data.title === "string" &&
    typeof data.file === "string"
  );
}

export default function btw(pi: ExtensionAPI): void {
  const threads = new Map<string, Thread>();
  const listeners = new Set<() => void>();
  const tasks = new Set<Promise<void>>();
  let selected: string | undefined;
  let generation = 0;
  let overlayOpen = false;

  function refresh(ctx: ExtensionContext): void {
    const busy = [...threads.values()].filter((thread) => thread.busy).length;
    ctx.ui.setStatus(
      "btw",
      threads.size
        ? `BTW ${threads.size}${busy ? ` · ${busy} running` : ""}`
        : undefined,
    );
    for (const listener of listeners) listener();
  }

  pi.on("session_start", (_event, ctx) => {
    threads.clear();
    selected = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === DELETE_ENTRY) {
        const data = entry.data as { id?: unknown } | undefined;
        if (typeof data?.id === "string") threads.delete(data.id);
      } else if (
        entry.customType === THREAD_ENTRY &&
        isThreadInfo(entry.data) &&
        existsSync(entry.data.file)
      ) {
        threads.set(entry.data.id, { ...entry.data, busy: false, draft: "" });
      }
    }
    selected = [...threads.keys()].at(-1);
    refresh(ctx);
  });

  pi.on("session_shutdown", async () => {
    generation++;
    await Promise.all(
      [...threads.values()].map((thread) => thread.session?.abort()),
    );
    await Promise.allSettled(tasks);
    for (const thread of threads.values()) thread.session?.dispose();
    threads.clear();
    listeners.clear();
  });

  function add(ctx: ExtensionContext, question = ""): Thread {
    const title =
      question.replace(/\s+/g, " ").slice(0, 72) || "Side conversation";
    const thread = createThread(ctx, title);
    const info: ThreadInfo = { id: thread.id, title, file: thread.file };
    pi.appendEntry(THREAD_ENTRY, info);
    threads.set(thread.id, thread);
    selected = thread.id;
    refresh(ctx);
    return thread;
  }

  function ask(ctx: ExtensionContext, thread: Thread, question: string): void {
    if (thread.busy) return;
    thread.busy = true;
    thread.error = undefined;
    thread.partial = "";
    thread.cancelRequested = false;
    const renamed = thread.title === "Side conversation";
    if (renamed) {
      thread.title = question.replace(/\s+/g, " ").slice(0, 72);
      const info: ThreadInfo = {
        id: thread.id,
        title: thread.title,
        file: thread.file,
      };
      pi.appendEntry(THREAD_ENTRY, info);
    }
    const owner = generation;
    refresh(ctx);
    const task = (async () => {
      let unsubscribe: (() => void) | undefined;
      try {
        const session = await openThread(ctx, thread);
        if (owner !== generation) {
          session.dispose();
          return;
        }
        if (renamed)
          session.sessionManager.appendSessionInfo(`BTW: ${thread.title}`);
        if (thread.cancelRequested) return;
        unsubscribe = session.subscribe((event) => {
          if (owner !== generation) return;
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
          ) {
            thread.partial += event.assistantMessageEvent.delta;
          } else if (
            event.type === "message_end" &&
            event.message.role === "assistant"
          ) {
            thread.partial = "";
          } else if (event.type === "tool_execution_start") {
            thread.tool = event.toolName;
          } else if (event.type === "tool_execution_end") {
            thread.tool = undefined;
          }
          refresh(ctx);
        });
        await session.prompt(question, { expandPromptTemplates: false });
        const last = session.messages.at(-1);
        if (last?.role === "assistant" && last.stopReason === "error") {
          throw new Error(last.errorMessage ?? "BTW model request failed");
        }
      } catch (error) {
        thread.error = error instanceof Error ? error.message : String(error);
      } finally {
        unsubscribe?.();
        thread.busy = false;
        thread.partial = "";
        thread.tool = undefined;
        if (owner === generation) {
          refresh(ctx);
          if (!overlayOpen && !thread.cancelRequested)
            ctx.ui.notify(
              `BTW ${thread.id}: ${thread.error ?? "answer ready — /btws to reopen"}`,
              thread.error ? "error" : "info",
            );
        }
      }
    })();
    thread.task = task;
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  }

  async function deleteThread(
    ctx: ExtensionContext,
    thread: Thread,
  ): Promise<void> {
    thread.cancelRequested = true;
    await thread.session?.abort();
    // Wait for initialization and prompt persistence before removing the transcript.
    await thread.task;
    thread.session?.dispose();
    removeThreadFile(thread);
    pi.appendEntry(DELETE_ENTRY, { id: thread.id });
    threads.delete(thread.id);
    if (selected === thread.id) selected = [...threads.keys()].at(-1);
    refresh(ctx);
  }

  async function pick(ctx: ExtensionContext): Promise<Thread | undefined> {
    const choices = [...threads.values()];
    if (!choices.length) return undefined;
    const labels = choices.map(
      (thread) =>
        `${thread.id} · ${thread.busy ? "[working] " : ""}${thread.title}`,
    );
    const choice = await ctx.ui.select("BTW threads", labels);
    return choice ? choices[labels.indexOf(choice)] : undefined;
  }

  async function exportThread(
    ctx: ExtensionContext,
    thread: Thread,
  ): Promise<void> {
    const file = breakOut(thread, ctx.cwd);
    const command = resumeCommand(file, ctx.cwd);
    if (process.env.HERDR_ENV !== "1") {
      ctx.ui.notify(
        `Independent session saved. Resume in another terminal:\n${command}`,
        "info",
      );
      return;
    }
    const workspace = process.env.HERDR_WORKSPACE_ID;
    if (!workspace)
      throw new Error(
        `Missing Herdr workspace context. Saved session:\n${command}`,
      );
    const herdr = async (args: string[], timeout = 10000): Promise<string> => {
      const result = await pi.exec(
        process.env.HERDR_BIN_PATH || "herdr",
        args,
        { timeout },
      );
      if (result.code !== 0)
        throw new Error(
          result.stderr.trim() ||
            result.stdout.trim() ||
            "Herdr command failed",
        );
      return result.stdout;
    };
    let tab: string | undefined;
    try {
      const args = [
        "tab",
        "create",
        "--workspace",
        workspace,
        "--cwd",
        ctx.cwd,
        "--label",
        `BTW: ${thread.title}`,
        "--no-focus",
      ];
      if (process.env.PI_CODING_AGENT_DIR)
        args.push(
          "--env",
          `PI_CODING_AGENT_DIR=${process.env.PI_CODING_AGENT_DIR}`,
        );
      const created = JSON.parse(await herdr(args)) as {
        result?: {
          tab?: { tab_id?: string };
          root_pane?: { pane_id?: string };
        };
      };
      tab = created.result?.tab?.tab_id;
      const pane = created.result?.root_pane?.pane_id;
      if (typeof tab !== "string" || typeof pane !== "string")
        throw new Error("Herdr did not return a tab and root pane ID");
      await herdr(
        [
          "agent",
          "start",
          `btw-${thread.id}-${randomUUID().slice(0, 6)}`,
          "--kind",
          "pi",
          "--pane",
          pane,
          "--",
          "--session",
          file,
        ],
        35000,
      );
      await herdr(["tab", "focus", tab]);
      ctx.ui.notify(
        `Breakout opened in Herdr tab ${tab}. The original BTW remains read-only.`,
        "info",
      );
    } catch (error) {
      throw new Error(
        `Herdr breakout failed${tab ? ` (tab ${tab})` : ""}: ${String(error)}\nThe independent session is saved; do not repeat breakout to retry:\n${command}`,
      );
    }
  }

  async function open(
    ctx: ExtensionCommandContext,
    initial: Thread,
  ): Promise<void> {
    overlayOpen = true;
    let thread = initial;
    try {
      while (true) {
        selected = thread.id;
        const position = `${[...threads.keys()].indexOf(thread.id) + 1}/${threads.size}`;
        const action = await showThread(
          ctx,
          thread,
          position,
          (question) => ask(ctx, thread, question),
          (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        );
        if (action === "close") return;
        if (action === "delete") {
          await deleteThread(ctx, thread);
          return;
        }
        if (action === "new") thread = add(ctx);
        else if (action === "switch") {
          const chosen = await pick(ctx);
          if (chosen) thread = chosen;
        } else {
          try {
            await exportThread(ctx, thread);
            return;
          } catch (error) {
            ctx.ui.notify(String(error), "error");
          }
        }
      }
    } finally {
      overlayOpen = false;
    }
  }

  function command(
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>,
  ) {
    return async (args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("BTW requires interactive terminal mode.", "error");
        return;
      }
      if (overlayOpen) return;
      try {
        await handler(args.trim(), ctx);
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    };
  }

  pi.registerCommand("btw", {
    description:
      "Ask a new read-only side question, or reopen the selected BTW thread",
    handler: command(async (question, ctx) => {
      const thread = question
        ? add(ctx, question)
        : (selected && threads.get(selected)) || add(ctx);
      if (question) ask(ctx, thread, question);
      await open(ctx, thread);
    }),
  });
  pi.registerCommand("btws", {
    description: "List and resume this session's BTW threads",
    handler: command(async (_args, ctx) => {
      const thread = await pick(ctx);
      if (thread) await open(ctx, thread);
      else if (!threads.size)
        ctx.ui.notify("No BTW threads yet. Use /btw <question>.", "info");
    }),
  });
  pi.registerCommand("btw-breakout", {
    description:
      "Open a BTW thread as an independent Pi session in a new Herdr tab",
    getArgumentCompletions: (prefix) => {
      const matches = [...threads.values()].filter((thread) =>
        thread.id.startsWith(prefix),
      );
      return matches.length
        ? matches.map((thread) => ({
            value: thread.id,
            label: `${thread.id} · ${thread.title}${thread.busy ? " [working]" : ""}`,
          }))
        : null;
    },
    handler: command(async (id, ctx) => {
      const thread = id
        ? threads.get(id)
        : selected
          ? threads.get(selected)
          : undefined;
      if (!thread)
        throw new Error(
          "Choose an existing BTW thread with /btws, or provide its ID.",
        );
      await exportThread(ctx, thread);
    }),
  });
}
