import {
  getMarkdownTheme,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  Loader,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { transcript, type Thread } from "./session.ts";

export type OverlayAction = "close" | "new" | "switch" | "breakout" | "delete";

export async function showThread(
  ctx: ExtensionContext,
  thread: Thread,
  position: string,
  ask: (question: string) => void,
  subscribe: (refresh: () => void) => () => void,
): Promise<OverlayAction> {
  return ctx.ui.custom<OverlayAction>(
    (tui, theme, _keys, done) => {
      const input = new Input({
        prompt: "> ",
        placeholder: "Ask a follow-up…",
      });
      input.setValue(thread.draft);
      let offset = 0;
      let bodyHeight = 10;
      let cachedText: string | undefined;
      let markdown = new Markdown("", 0, 0, getMarkdownTheme());
      let closed = false;
      const loader = new Loader(
        tui,
        (text) => theme.fg("accent", text),
        (text) => theme.fg("muted", text),
        "Working…",
      );
      loader.stop();
      let spinning = false;
      let workMessage = "Working…";
      const finish = (action: OverlayAction) => {
        if (closed) return;
        closed = true;
        loader.stop();
        thread.draft = input.getValue();
        done(action);
      };
      const refresh = () => {
        if (closed) return;
        if (thread.busy !== spinning) {
          spinning = thread.busy;
          if (spinning) loader.start();
          else loader.stop();
        }
        const message = thread.tool ? `Working · ${thread.tool}` : "Working…";
        if (message !== workMessage) {
          workMessage = message;
          loader.setMessage(message);
        }
        tui.requestRender();
      };
      const unsubscribe = subscribe(refresh);
      refresh();
      input.onSubmit = (text) => {
        if (!text.trim() || thread.busy) return;
        input.setValue("");
        thread.draft = "";
        offset = 0;
        ask(text.trim());
      };
      input.onEscape = () => finish("close");
      return {
        get focused() {
          return input.focused;
        },
        set focused(value: boolean) {
          input.focused = value;
        },
        render(width: number): string[] {
          if (width < 5) return [truncateToWidth("BTW", width)];
          const innerWidth = width - 4;
          const height = Math.floor(tui.terminal.rows * 0.95);
          bodyHeight = Math.max(1, Math.min(28, height - 9));
          const text =
            transcript(thread) ||
            "Ask a side question below. This thread has read-only file access.";
          if (text !== cachedText) {
            cachedText = text;
            markdown = new Markdown(text, 0, 0, getMarkdownTheme());
          }
          const lines = markdown.render(innerWidth);
          const maxOffset = Math.max(0, lines.length - bodyHeight);
          offset = Math.min(offset, maxOffset);
          const end = lines.length - offset;
          const visible = lines.slice(Math.max(0, end - bodyHeight), end);
          const status = thread.error
            ? theme.fg("error", thread.error)
            : thread.busy
              ? (loader.render(innerWidth).slice(1, 2)[0] ?? "")
              : theme.fg("muted", "Read-only · read, grep, find, ls");
          const content = [
            theme.fg(
              "accent",
              `BTW ${position} · ${thread.id} · ${thread.title}`,
            ),
            "",
            ...visible,
            ...Array<string>(Math.max(0, bodyHeight - visible.length)).fill(""),
            "",
            status,
            ...input.render(innerWidth),
            theme.fg(
              "dim",
              "Enter send · PgUp/PgDn scroll · Ctrl+N new · Ctrl+T threads",
            ),
            theme.fg(
              "dim",
              "Ctrl+B breakout · Ctrl+C delete thread · Esc background",
            ),
          ];
          return [
            theme.fg("borderAccent", `╭${"─".repeat(width - 2)}╮`),
            ...content.map((line) => {
              const text = truncateToWidth(line, innerWidth);
              return (
                theme.fg("borderAccent", "│ ") +
                text +
                " ".repeat(Math.max(0, innerWidth - visibleWidth(text))) +
                theme.fg("borderAccent", " │")
              );
            }),
            theme.fg("borderAccent", `╰${"─".repeat(width - 2)}╯`),
          ];
        },
        handleInput(data: string): void {
          if (matchesKey(data, "ctrl+n")) finish("new");
          else if (matchesKey(data, "ctrl+t")) finish("switch");
          else if (matchesKey(data, "ctrl+b")) finish("breakout");
          else if (matchesKey(data, "ctrl+c")) finish("delete");
          else if (matchesKey(data, "pageUp")) offset += bodyHeight;
          else if (matchesKey(data, "pageDown"))
            offset = Math.max(0, offset - bodyHeight);
          else input.handleInput(data);
          tui.requestRender();
        },
        invalidate(): void {
          markdown.invalidate();
          input.invalidate();
          loader.invalidate();
          cachedText = undefined;
        },
        dispose(): void {
          closed = true;
          loader.stop();
          unsubscribe();
        },
      };
    },
    { overlay: true, overlayOptions: { width: "85%", maxHeight: "95%" } },
  );
}
