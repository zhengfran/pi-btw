import { watchFile, unwatchFile } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  getAgentDir,
  SettingsManager,
  type ExtensionContext,
  type ReadonlyFooterDataProvider,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";

function tokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1000000) return `${Math.round(value / 1000)}k`;
  if (value < 10000000) return `${(value / 1000000).toFixed(1)}M`;
  return `${Math.round(value / 1000000)}M`;
}

export function createFooter(
  ctx: ExtensionContext,
  tui: TUI,
  theme: Theme,
  data: ReadonlyFooterDataProvider,
  indicator: () => string,
) {
  const unsubscribe = data.onBranchChange(() => tui.requestRender());
  const settings = SettingsManager.create(ctx.cwd, undefined, {
    projectTrusted: ctx.isProjectTrusted(),
  });
  let disposed = false;
  const reloadSettings = () => {
    void settings.reload().then(() => {
      if (!disposed) tui.requestRender();
    });
  };
  const settingsFiles = [
    join(getAgentDir(), "settings.json"),
    join(ctx.cwd, ".pi", "settings.json"),
  ];
  for (const file of settingsFiles)
    watchFile(file, { persistent: false, interval: 1000 }, reloadSettings);
  let cachedLeaf: string | null | undefined;
  let stats: string[] = [];

  return {
    dispose(): void {
      disposed = true;
      unsubscribe();
      for (const file of settingsFiles) unwatchFile(file, reloadSettings);
    },
    invalidate: reloadSettings,
    render(width: number): string[] {
      // Match Pi's cumulative totals, including tool, compaction and auxiliary usage.
      const leaf = ctx.sessionManager.getLeafId();
      if (cachedLeaf !== leaf) {
        cachedLeaf = leaf;
        let input = 0,
          output = 0,
          cacheRead = 0,
          cacheWrite = 0,
          cost = 0;
        let hitRate: number | undefined;
        for (const entry of ctx.sessionManager.getEntries()) {
          const usage =
            entry.type === "usage"
              ? entry.usage
              : entry.type === "compaction" || entry.type === "branch_summary"
                ? entry.usage
                : entry.type === "message" &&
                    (entry.message.role === "assistant" ||
                      entry.message.role === "toolResult")
                  ? entry.message.usage
                  : undefined;
          if (!usage) continue;
          input += usage.input;
          output += usage.output;
          cacheRead += usage.cacheRead;
          cacheWrite += usage.cacheWrite;
          cost += usage.cost.total;
          if (entry.type === "message" && entry.message.role === "assistant") {
            const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
            hitRate = prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
          }
        }
        stats = [];
        if (input) stats.push(`↑${tokens(input)}`);
        if (output) stats.push(`↓${tokens(output)}`);
        if (cacheRead) stats.push(`R${tokens(cacheRead)}`);
        if (cacheWrite) stats.push(`W${tokens(cacheWrite)}`);
        if ((cacheRead || cacheWrite) && hitRate !== undefined)
          stats.push(`CH${hitRate.toFixed(1)}%`);
        if (cost) stats.push(`$${cost.toFixed(3)}`);
      }
      const model = ctx.model;
      const subscription =
        model &&
        (model.provider === "kimi-coding" ||
          (ctx.modelRegistry.isUsingOAuth(model) &&
            ctx.modelRegistry.getProvider(model.provider)?.auth?.oauth
              ?.isSubscription));
      const parts = stats.map((part) =>
        part.startsWith("$") && subscription ? `${part} (sub)` : part,
      );
      if (subscription && !parts.some((part) => part.startsWith("$")))
        parts.push("$0.000 (sub)");
      const usage = ctx.getContextUsage();
      const percent = usage?.percent;
      const context =
        `${percent === null ? "?" : (percent ?? 0).toFixed(1) + "%"}/${tokens(usage?.contextWindow ?? model?.contextWindow ?? 0)}` +
        (settings.getCompactionSettings(model).enabled ? " (auto)" : "");
      parts.push(
        theme.fg(
          (percent ?? 0) > 90
            ? "error"
            : (percent ?? 0) > 70
              ? "warning"
              : "dim",
          context,
        ),
      );
      const left = truncateToWidth(
        theme.fg("dim", parts.join(" ")),
        width,
        "...",
      );
      let right = model?.id ?? "no-model";
      if (model?.reasoning) {
        const thinking = ctx.thinkingLevel ?? "off";
        right += ` • ${thinking === "off" ? "thinking off" : thinking}`;
      }
      if (data.getAvailableProviderCount() > 1 && model) {
        const withProvider = `(${model.provider}) ${right}`;
        if (visibleWidth(left) + 2 + visibleWidth(withProvider) <= width)
          right = withProvider;
      }
      const room = width - visibleWidth(left) - 2;
      right = room > 0 ? truncateToWidth(theme.fg("dim", right), room, "") : "";
      const statsLine =
        left +
        " ".repeat(
          Math.max(0, width - visibleWidth(left) - visibleWidth(right)),
        ) +
        right;

      let cwd = ctx.sessionManager.getCwd();
      const home = process.env.HOME || process.env.USERPROFILE;
      if (home) {
        const path = relative(resolve(home), resolve(cwd));
        if (
          path === "" ||
          (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
        )
          cwd = path ? `~${sep}${path}` : "~";
      }
      const branch = data.getGitBranch();
      const name = ctx.sessionManager.getSessionName();
      const project =
        cwd + (branch ? ` (${branch})` : "") + (name ? ` • ${name}` : "");
      const btw = indicator();
      const suffix = theme.fg("dim", " · ") + btw;
      const available = width - visibleWidth(suffix);
      const firstLine =
        available > 0
          ? truncateToWidth(theme.fg("dim", project), available, "…") + suffix
          : truncateToWidth(btw, width, "");
      const lines = [firstLine, statsLine];
      const statuses = [...data.getExtensionStatuses()]
        .filter(([key]) => key !== "btw")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) =>
          text
            .replace(/[\r\n\t]/g, " ")
            .replace(/ +/g, " ")
            .trim(),
        );
      if (statuses.length)
        lines.push(
          truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")),
        );
      return lines;
    },
  };
}
