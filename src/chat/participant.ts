import * as vscode from "vscode";
import {
  clientFromConfig,
  OpencodeClient,
  OpencodeHttpError,
  type MessagePart,
} from "../opencode/http";

const SESSION_KEY = "dux.opencode.sessionId";
export const PARTICIPANT_ID = "dux.opencode";

function selectionContext(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const selection = editor.selection;
  if (selection.isEmpty) {
    return undefined;
  }
  const text = editor.document.getText(selection);
  if (!text.trim()) {
    return undefined;
  }
  const file = editor.document.uri.fsPath;
  const start = selection.start.line + 1;
  const end = selection.end.line + 1;
  return `Selected code from ${file}#L${start}-${end}:\n\`\`\`\n${text}\n\`\`\``;
}

function buildParts(prompt: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const context = selectionContext();
  if (context) {
    parts.push({ type: "text", text: context });
  }
  parts.push({ type: "text", text: prompt });
  return parts;
}

async function ensureSession(
  context: vscode.ExtensionContext,
  client: OpencodeClient,
  forceNew: boolean,
  token: vscode.CancellationToken,
): Promise<string> {
  if (!forceNew) {
    const existing = context.workspaceState.get<string>(SESSION_KEY);
    if (existing) {
      return existing;
    }
  }
  const session = await client.createSession("VS Code Chat", toAbortSignal(token));
  await context.workspaceState.update(SESSION_KEY, session.id);
  return session.id;
}

function toAbortSignal(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  } else {
    token.onCancellationRequested(() => controller.abort());
  }
  return controller.signal;
}

export function registerOpencodeParticipant(context: vscode.ExtensionContext): vscode.Disposable {
  const handler: vscode.ChatRequestHandler = async (
    request,
    _chatContext,
    stream,
    token,
  ): Promise<vscode.ChatResult> => {
    const config = vscode.workspace.getConfiguration();
    const client = clientFromConfig(config);

    try {
      if (request.command === "health") {
        stream.progress("Checking OpenCode health…");
        const health = await client.getHealth(toAbortSignal(token));
        stream.markdown(
          `OpenCode serve is **healthy** (version \`${health.version ?? "unknown"}\`).\n\nBase URL: \`${config.get("dux.opencode.baseUrl")}\``,
        );
        return { metadata: { command: "health" } };
      }

      if (request.command === "new") {
        await context.workspaceState.update(SESSION_KEY, undefined);
        const sessionId = await ensureSession(context, client, true, token);
        stream.markdown(`Started a new OpenCode session (\`${sessionId}\`).`);
        if (request.prompt.trim()) {
          await runPrompt(context, client, request.prompt, stream, token);
        }
        return { metadata: { command: "new" } };
      }

      if (!request.prompt.trim()) {
        stream.markdown("Send a prompt after `@opencode`, or use `/new` / `/health`.");
        return {};
      }

      await runPrompt(context, client, request.prompt, stream, token);
      return {};
    } catch (error) {
      const message = formatError(error);
      stream.markdown(`**OpenCode error:** ${message}`);
      return {};
    }
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = new vscode.ThemeIcon("robot");
  return participant;
}

async function runPrompt(
  context: vscode.ExtensionContext,
  client: OpencodeClient,
  prompt: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  stream.progress("Checking OpenCode serve…");
  await client.getHealth(toAbortSignal(token));

  const sessionId = await ensureSession(context, client, false, token);
  const parts = buildParts(prompt);
  const signal = toAbortSignal(token);

  const abortSub = token.onCancellationRequested(() => {
    void client.abortSession(sessionId).catch(() => undefined);
  });

  try {
    await client.streamPrompt(sessionId, parts, {
      signal,
      onProgress: (message) => stream.progress(message),
      onText: (chunk) => stream.markdown(chunk),
    });
  } finally {
    abortSub.dispose();
  }
}

function formatError(error: unknown): string {
  if (error instanceof OpencodeHttpError) {
    return error.message;
  }
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.message === "Cancelled") {
      return "Request cancelled.";
    }
    return error.message;
  }
  return String(error);
}

export async function runHealthCommand(): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const client = clientFromConfig(config);
  try {
    const health = await client.getHealth();
    vscode.window.showInformationMessage(
      `OpenCode healthy (version ${health.version ?? "unknown"}) at ${config.get("dux.opencode.baseUrl")}`,
    );
  } catch (error) {
    vscode.window.showErrorMessage(formatError(error));
  }
}
