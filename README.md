# dux

VS Code Chat participant that connects to a running [`opencode serve`](https://opencode.ai/docs/server/) instance over HTTP.

## Install into Visual Studio Code

One command from the repo root:

```bash
./scripts/install-vscode.sh
```

Or:

```bash
npm run install:vscode
```

This installs dependencies, compiles the extension, builds a `.vsix`, and runs `code --install-extension`.

Requirements:

- Node.js + npm
- VS Code CLI (`code`) on your `PATH`  
  (Command Palette → **Shell Command: Install 'code' command in PATH**)

If `code` is not on your PATH:

```bash
VSCODE_CLI="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ./scripts/install-vscode.sh
```

Then reload VS Code, start `opencode serve`, and use `@opencode` in Chat.

## Prerequisites

1. Install [OpenCode](https://opencode.ai/docs/).
2. Start a headless server in your project directory:

```bash
opencode serve
```

Default URL: `http://127.0.0.1:4096`.

## Develop

```bash
npm install
npm run compile
```

Press **F5** (`Run Extension`) to open an Extension Development Host.

## Use

1. Open **Chat** in VS Code.
2. Mention `@opencode` and send a prompt.
3. Optional slash commands:
   - `/new` — start a new OpenCode session
   - `/health` — check serve health

Command palette: **Dux: Check OpenCode Serve Health**.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `dux.opencode.baseUrl` | `http://127.0.0.1:4096` | OpenCode serve base URL |
| `dux.opencode.username` | `opencode` | Basic auth username |
| `dux.opencode.password` | _(empty)_ | Basic auth password (`OPENCODE_SERVER_PASSWORD`) |

If the editor has a non-empty selection, it is included as context with the prompt.

## How it works

The extension is an attach-only HTTP client:

1. `GET /global/health`
2. `POST /session` (workspace-scoped session id)
3. `GET /event` (SSE) + `POST /session/:id/prompt_async`
4. Streams text into Chat; cancel calls `POST /session/:id/abort`
5. Falls back to blocking `POST /session/:id/message` if streaming yields no text

## Smoke checklist

- [ ] `opencode serve` is running
- [ ] **Dux: Check OpenCode Serve Health** reports a version
- [ ] `@opencode hello` returns a reply in Chat
- [ ] Cancel while running aborts the request
- [ ] `@opencode /new` creates a fresh session
