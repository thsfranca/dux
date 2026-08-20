export type HealthResponse = {
  healthy: boolean;
  version: string;
};

export type Session = {
  id: string;
  title?: string;
};

export type TextPart = {
  type: "text";
  text: string;
};

export type MessagePart = TextPart | { type: string; [key: string]: unknown };

export type MessageResult = {
  info: { id?: string; role?: string; [key: string]: unknown };
  parts: MessagePart[];
};

export type OpencodeClientOptions = {
  baseUrl: string;
  username?: string;
  password?: string;
};

export type StreamHandlers = {
  onText?: (text: string) => void;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
};

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

function authHeaders(options: OpencodeClientOptions): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (options.password) {
    const user = options.username || "opencode";
    const token = Buffer.from(`${user}:${options.password}`, "utf8").toString("base64");
    headers.Authorization = `Basic ${token}`;
  }
  return headers;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500) || response.statusText;
  } catch {
    return response.statusText;
  }
}

export class OpencodeHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OpencodeHttpError";
  }
}

export class OpencodeClient {
  constructor(private readonly options: OpencodeClientOptions) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { ...authHeaders(this.options), ...extra };
  }

  async getHealth(signal?: AbortSignal): Promise<HealthResponse> {
    const response = await fetch(joinUrl(this.options.baseUrl, "/global/health"), {
      method: "GET",
      headers: this.headers(),
      signal,
    });
    if (!response.ok) {
      throw new OpencodeHttpError(
        `Health check failed (${response.status}): ${await readErrorBody(response)}`,
        response.status,
      );
    }
    return (await response.json()) as HealthResponse;
  }

  async createSession(title?: string, signal?: AbortSignal): Promise<Session> {
    const response = await fetch(joinUrl(this.options.baseUrl, "/session"), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(title ? { title } : {}),
      signal,
    });
    if (!response.ok) {
      throw new OpencodeHttpError(
        `Create session failed (${response.status}): ${await readErrorBody(response)}`,
        response.status,
      );
    }
    return (await response.json()) as Session;
  }

  async abortSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    const response = await fetch(joinUrl(this.options.baseUrl, `/session/${sessionId}/abort`), {
      method: "POST",
      headers: this.headers(),
      signal,
    });
    if (!response.ok && response.status !== 404) {
      throw new OpencodeHttpError(
        `Abort failed (${response.status}): ${await readErrorBody(response)}`,
        response.status,
      );
    }
  }

  async sendMessage(
    sessionId: string,
    parts: MessagePart[],
    signal?: AbortSignal,
  ): Promise<MessageResult> {
    const response = await fetch(joinUrl(this.options.baseUrl, `/session/${sessionId}/message`), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ parts }),
      signal,
    });
    if (!response.ok) {
      throw new OpencodeHttpError(
        `Send message failed (${response.status}): ${await readErrorBody(response)}`,
        response.status,
      );
    }
    return (await response.json()) as MessageResult;
  }

  async promptAsync(
    sessionId: string,
    parts: MessagePart[],
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch(
      joinUrl(this.options.baseUrl, `/session/${sessionId}/prompt_async`),
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ parts }),
        signal,
      },
    );
    if (!response.ok && response.status !== 204) {
      throw new OpencodeHttpError(
        `prompt_async failed (${response.status}): ${await readErrorBody(response)}`,
        response.status,
      );
    }
  }

  /**
   * Stream a prompt: open SSE, send prompt_async, emit text deltas until the
   * session returns to idle after work has started. Falls back to blocking
   * /message if async streaming yields no text.
   */
  async streamPrompt(
    sessionId: string,
    parts: MessagePart[],
    handlers: StreamHandlers = {},
  ): Promise<string> {
    const signal = handlers.signal;
    let collected = "";
    let sawBusy = false;
    let finished = false;

    const appendText = (chunk: string) => {
      if (!chunk) {
        return;
      }
      collected += chunk;
      handlers.onText?.(chunk);
    };

    const handleEvent = (raw: unknown): void => {
      if (!raw || typeof raw !== "object") {
        return;
      }
      const event = raw as {
        type?: string;
        properties?: Record<string, unknown>;
      };
      const type = event.type;
      const props = event.properties ?? {};

      if (type === "server.connected") {
        return;
      }

      if (type === "session.status" || type === "session.idle" || type === "session.busy") {
        const status = normalizeSessionStatus(type, props);
        if (status === "busy") {
          sawBusy = true;
          handlers.onProgress?.("OpenCode is working…");
        }
        if (sawBusy && status === "idle") {
          finished = true;
        }
        return;
      }

      if (type === "message.part.delta") {
        const delta = typeof props.delta === "string" ? props.delta : undefined;
        if (delta) {
          sawBusy = true;
          appendText(delta);
        }
        return;
      }

      if (type === "message.part.updated") {
        const part = props.part as MessagePart | undefined;
        const delta = typeof props.delta === "string" ? props.delta : undefined;
        if (delta) {
          sawBusy = true;
          appendText(delta);
          return;
        }
        if (part && part.type === "text" && typeof part.text === "string") {
          // Full snapshot — only append the unseen suffix.
          const text = part.text;
          if (text.startsWith(collected)) {
            const next = text.slice(collected.length);
            if (next) {
              sawBusy = true;
              appendText(next);
            }
          } else if (text && text !== collected) {
            sawBusy = true;
            appendText(text);
          }
        }
      }
    };

    handlers.onProgress?.("Connecting to OpenCode event stream…");
    const sse = await this.openEventStream(signal);

    try {
      const pump = this.pumpSse(sse, handleEvent, () => finished, signal);

      handlers.onProgress?.("Sending prompt…");
      await this.promptAsync(sessionId, parts, signal);

      const timeoutMs = 10 * 60 * 1000;
      const deadline = Date.now() + timeoutMs;
      while (!finished && !signal?.aborted && Date.now() < deadline) {
        if (await racePumpTick(pump, 250)) {
          break;
        }
      }
      finished = true;
      sse.abort();
      await pump.catch(() => undefined);

      if (signal?.aborted) {
        throw new Error("Cancelled");
      }

      if (collected.trim()) {
        return collected;
      }

      handlers.onProgress?.("Streaming returned no text; falling back to blocking message…");
      const result = await this.sendMessage(sessionId, parts, signal);
      const text = extractTextParts(result.parts);
      if (text) {
        appendText(text);
      }
      return collected;
    } finally {
      sse.abort();
    }
  }

  private async openEventStream(signal?: AbortSignal): Promise<{
    response: Response;
    abort: () => void;
  }> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);

    const response = await fetch(joinUrl(this.options.baseUrl, "/event"), {
      method: "GET",
      headers: this.headers({ Accept: "text/event-stream" }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      signal?.removeEventListener("abort", onAbort);
      throw new OpencodeHttpError(
        `SSE /event failed (${response.status}): ${await readErrorBody(response)}`,
        response.status,
      );
    }

    return {
      response,
      abort: () => {
        signal?.removeEventListener("abort", onAbort);
        controller.abort();
      },
    };
  }

  private async pumpSse(
    sse: { response: Response },
    onEvent: (data: unknown) => void,
    isDone: () => boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = sse.response.body;
    if (!body) {
      return;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!isDone() && !signal?.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";

        for (const chunk of chunks) {
          const dataLines = chunk
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart());
          if (dataLines.length === 0) {
            continue;
          }
          const payload = dataLines.join("\n");
          if (!payload || payload === "[DONE]") {
            continue;
          }
          try {
            onEvent(JSON.parse(payload));
          } catch {
            // ignore malformed SSE frames
          }
          if (isDone()) {
            return;
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }
}

export function extractTextParts(parts: MessagePart[]): string {
  return parts
    .filter((p): p is TextPart => p.type === "text" && typeof (p as TextPart).text === "string")
    .map((p) => p.text)
    .join("");
}

function normalizeSessionStatus(
  type: string,
  props: Record<string, unknown>,
): "busy" | "idle" | undefined {
  if (type === "session.busy") {
    return "busy";
  }
  if (type === "session.idle") {
    return "idle";
  }
  const status = props.status;
  if (typeof status === "string") {
    if (status === "busy" || status === "running" || status === "processing") {
      return "busy";
    }
    if (status === "idle" || status === "complete") {
      return "idle";
    }
  }
  if (status && typeof status === "object") {
    const nested = status as { type?: string };
    if (nested.type === "busy" || nested.type === "running") {
      return "busy";
    }
    if (nested.type === "idle" || nested.type === "complete") {
      return "idle";
    }
  }
  return undefined;
}

/** Returns true if the pump promise settled. */
async function racePumpTick(pump: Promise<void>, ms: number): Promise<boolean> {
  let settled = false;
  await Promise.race([
    pump.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    ),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
  return settled;
}

export function clientFromConfig(config: {
  get: (key: string) => unknown;
}): OpencodeClient {
  const baseUrl = String(config.get("dux.opencode.baseUrl") ?? "http://127.0.0.1:4096");
  const username = String(config.get("dux.opencode.username") ?? "opencode");
  const password = String(config.get("dux.opencode.password") ?? "");
  return new OpencodeClient({
    baseUrl,
    username,
    password: password || undefined,
  });
}
