import * as vscode from "vscode";
import { registerOpencodeParticipant, runHealthCommand } from "./chat/participant";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    registerOpencodeParticipant(context),
    vscode.commands.registerCommand("dux.opencode.checkHealth", () => runHealthCommand()),
  );
}

export function deactivate(): void {
  // no-op
}
