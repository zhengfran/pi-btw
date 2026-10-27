import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  createAgentSession,
  CURRENT_SESSION_VERSION,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export const THREAD_ENTRY = "btw.thread.v1";
export const DELETE_ENTRY = "btw.deleted.v1";
export const ORIGIN_ENTRY = "btw.origin.v1";
export const READ_TOOLS = ["read", "grep", "find", "ls"];

export interface ThreadInfo {
  id: string;
  title: string;
  file: string;
}

export interface Thread extends ThreadInfo {
  session?: AgentSession;
  busy: boolean;
  error?: string;
  tool?: string;
  draft: string;
  partial?: string;
  cancelRequested?: boolean;
  task?: Promise<void>;
}

// A running parent may have persisted tool calls whose results have not arrived yet.
function settledBranch(entries: SessionEntry[]): SessionEntry[] {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message.role !== "assistant")
      continue;
    const calls = entry.message.content.filter(
      (part) => part.type === "toolCall",
    );
    if (!calls.length) continue;
    const results = new Set(
      entries
        .slice(i + 1)
        .flatMap((next) =>
          next.type === "message" && next.message.role === "toolResult"
            ? [next.message.toolCallId]
            : [],
        ),
    );
    if (calls.some((call) => !results.has(call.id))) return entries.slice(0, i);
  }
  return entries;
}

export function createThread(ctx: ExtensionContext, title: string): Thread {
  const sessionId = randomUUID();
  const dir = join(getAgentDir(), "btw", ctx.sessionManager.getSessionId());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${sessionId}.jsonl`);
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: ctx.cwd,
    parentSession: ctx.sessionManager.getSessionFile(),
  };
  const branch = settledBranch(ctx.sessionManager.getBranch()).filter(
    (entry) => entry.type !== "custom" && entry.type !== "session_info",
  );
  const entries = branch.map((entry, index) => ({
    ...entry,
    parentId: index ? branch[index - 1].id : null,
  }));
  // Retain entry IDs: compaction boundaries and context edits refer to them.
  writeFileSync(
    file,
    [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") +
      "\n",
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  const manager = SessionManager.open(file);
  manager.appendCustomEntry(ORIGIN_ENTRY, { parent: header.parentSession });
  manager.appendSessionInfo(`BTW: ${title}`);
  if (ctx.model) manager.appendModelChange(ctx.model.provider, ctx.model.id);
  if (ctx.thinkingLevel) manager.appendThinkingLevelChange(ctx.thinkingLevel);
  return { id: sessionId.slice(0, 8), title, file, busy: false, draft: "" };
}

export async function openThread(
  ctx: ExtensionContext,
  thread: Thread,
): Promise<AgentSession> {
  if (thread.session) return thread.session;
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPrompt: [
      "You are answering a side question in an independent BTW thread. The main agent continues separately. " +
        "Only read, grep, find and ls are available. Inspect files as needed, but do not modify files, " +
        "execute shell commands, or continue the inherited main task. Answer the user's side question.",
    ],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create();
  // Preserve extension-provided models without loading their tools or lifecycle hooks.
  for (const id of ctx.modelRegistry.getRegisteredProviderIds()) {
    const native = ctx.modelRegistry.getRegisteredNativeProvider(id);
    if (native) modelRuntime.registerNativeProvider(native);
    const config = ctx.modelRegistry.getRegisteredProviderConfig(id);
    if (config) modelRuntime.registerProvider(id, config);
  }
  const manager = SessionManager.open(thread.file);
  const saved = manager.buildSessionContext().model;
  const model = saved
    ? ctx.modelRegistry.find(saved.provider, saved.modelId)
    : ctx.model;
  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    model: model ?? ctx.model,
    modelRuntime,
    tools: READ_TOOLS,
    resourceLoader,
    settingsManager,
    sessionManager: manager,
  });
  thread.session = session;
  return session;
}

export function transcript(thread: Thread): string {
  const entries = (
    thread.session?.sessionManager ?? SessionManager.open(thread.file)
  ).getBranch();
  const start = entries.findIndex(
    (entry) => entry.type === "custom" && entry.customType === ORIGIN_ENTRY,
  );
  const text = entries
    .slice(start + 1)
    .flatMap((entry) => {
      if (entry.type !== "message") return [];
      const message = entry.message;
      if (message.role !== "user" && message.role !== "assistant") return [];
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n");
      return text
        ? [`### ${message.role === "user" ? "You" : "BTW"}\n\n${text}`]
        : [];
    })
    .join("\n\n");
  return text + (thread.partial ? `\n\n### BTW\n\n${thread.partial}` : "");
}

export function removeThreadFile(thread: Thread): void {
  const root = resolve(getAgentDir(), "btw") + sep;
  if (!resolve(thread.file).startsWith(root))
    throw new Error(
      "Refusing to delete a transcript outside Pi's BTW directory",
    );
  rmSync(thread.file, { force: true });
}

export function breakOut(thread: Thread, cwd: string): string {
  if (thread.busy)
    throw new Error(
      "Wait for this BTW thread's answer before breaking it out.",
    );
  const manager = SessionManager.forkFrom(thread.file, cwd);
  manager.appendSessionInfo(thread.title);
  const file = manager.getSessionFile()!;
  const branch = manager.getBranch();
  let side = false;
  const kept = branch.filter((entry) => {
    if (entry.type === "custom" && entry.customType === ORIGIN_ENTRY)
      side = true;
    // Pi 1.x persists tool/prompt changes as system messages; do not export the read-only loadout.
    const role: string = entry.type === "message" ? entry.message.role : "";
    return !(side && role === "system");
  });
  const retained = new Set(kept.map((entry) => entry.id));
  const entries = kept.map((entry, index) => {
    const copy = { ...entry, parentId: index ? kept[index - 1].id : null };
    if (copy.type === "compaction" && !retained.has(copy.firstKeptEntryId)) {
      const boundary = branch.findIndex(
        (candidate) => candidate.id === copy.firstKeptEntryId,
      );
      copy.firstKeptEntryId = branch
        .slice(boundary + 1)
        .find((candidate) => retained.has(candidate.id))!.id;
    }
    return copy;
  });
  writeFileSync(
    file,
    [manager.getHeader(), ...entries]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  return file;
}

export function resumeCommand(file: string, cwd: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `cd ${quote(cwd)} && pi --session ${quote(file)}`;
}
