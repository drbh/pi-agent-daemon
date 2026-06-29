const EXPECTED_TEXT = "PI_DAEMON_E2E_OK";
const TEST_MODEL = "dummy";
const TEST_PROVIDER = "fake";
const STARTUP_TIMEOUT_MS = 60_000;

interface RpcRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface RpcMessage {
  ready?: boolean;
  id?: number;
  event?: string;
  data?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
}

function startFakeOpenAIProvider() {
  const requests: Array<Record<string, unknown>> = [];
  const abort = new AbortController();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: abort.signal,
    onListen: () => {},
  }, async (request) => {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      return new Response("not found", { status: 404 });
    }

    const body = await request.json() as Record<string, unknown>;
    requests.push(body);

    if (body.stream === true) {
      return streamCompletion();
    }

    return Response.json({
      id: "chatcmpl-e2e",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: TEST_MODEL,
      choices: [{
        index: 0,
        message: { role: "assistant", content: EXPECTED_TEXT },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });

  return {
    baseUrl: `http://${server.addr.hostname}:${server.addr.port}/v1`,
    requests,
    shutdown: () => abort.abort(),
  };
}

function streamCompletion(): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const chunks = [
        {
          id: "chatcmpl-e2e",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: TEST_MODEL,
          choices: [{
            index: 0,
            delta: { role: "assistant", content: EXPECTED_TEXT },
            finish_reason: null,
          }],
        },
        {
          id: "chatcmpl-e2e",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: TEST_MODEL,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: "stop",
          }],
        },
      ];

      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

class RpcClient {
  private nextId = 1;
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  private buffer = "";

  constructor(private conn: Deno.Conn) {}

  async ready() {
    const msg = await this.readMessage();
    if (!msg.ready) {
      throw new Error(`expected ready frame, got ${JSON.stringify(msg)}`);
    }
  }

  configure(baseUrl: string) {
    return this.request("configure", {
      providers: {
        [TEST_PROVIDER]: {
          baseUrl,
          apiKey: "test",
          api: "openai-completions",
          models: [{
            id: TEST_MODEL,
            name: "Dummy",
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 4096,
            maxTokens: 128,
            compat: {
              maxTokensField: "max_tokens",
              supportsStore: false,
              supportsUsageInStreaming: false,
            },
          }],
        },
      },
    });
  }

  async createSession(): Promise<string> {
    const result = await this.request("create_session", {
      system_prompt: "You are a deterministic e2e test assistant.",
      tools: [],
      model: `${TEST_PROVIDER}/${TEST_MODEL}`,
      cwd: "/tmp",
    });
    const sessionId = result.session_id;
    if (typeof sessionId !== "string") {
      throw new Error(`missing session_id: ${JSON.stringify(result)}`);
    }
    return sessionId;
  }

  async prompt(sessionId: string, message: string): Promise<{
    events: string;
    result: string;
  }> {
    const id = this.nextId++;
    await this.write({
      id,
      method: "prompt",
      params: { session_id: sessionId, message },
    });

    let events = "";
    while (true) {
      const msg = await this.readMessage();
      if (msg.id !== id) {
        throw new Error(`unexpected response id: ${JSON.stringify(msg)}`);
      }
      if (msg.error) {
        throw new Error(msg.error);
      }
      if (msg.event === "text_delta") {
        events += String(msg.data?.delta ?? "");
        continue;
      }
      if (msg.result) {
        return {
          events,
          result: String(msg.result.response ?? ""),
        };
      }
    }
  }

  disposeSession(sessionId: string) {
    return this.request("dispose_session", { session_id: sessionId });
  }

  configureAuthPath(authPath: string) {
    return this.request("configure", { auth_path: authPath });
  }

  authStatus(provider?: string) {
    return this.request("auth_status", provider ? { provider } : {});
  }

  async expectError(
    method: string,
    params: Record<string, unknown>,
  ): Promise<string> {
    try {
      await this.request(method, params);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error(`expected ${method} to fail, but it succeeded`);
  }

  shutdown() {
    return this.request("shutdown", {});
  }

  close() {
    try {
      this.conn.close();
    } catch {
      // already closed
    }
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    await this.write({ id, method, params });
    while (true) {
      const msg = await this.readMessage();
      if (msg.id !== id) {
        throw new Error(`unexpected response id: ${JSON.stringify(msg)}`);
      }
      if (msg.error) {
        throw new Error(msg.error);
      }
      if (msg.result) {
        return msg.result;
      }
    }
  }

  private async write(req: RpcRequest) {
    const bytes = this.encoder.encode(`${JSON.stringify(req)}\n`);
    let written = 0;
    while (written < bytes.length) {
      written += await this.conn.write(bytes.subarray(written));
    }
  }

  private async readMessage(): Promise<RpcMessage> {
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) {
          return JSON.parse(line) as RpcMessage;
        }
      }

      const chunk = new Uint8Array(1024 * 64);
      const n = await this.conn.read(chunk);
      if (n === null) {
        throw new Error("daemon closed the RPC connection");
      }
      this.buffer += this.decoder.decode(chunk.subarray(0, n), { stream: true });
    }
  }
}

async function checkAuthStatusAndPath(client: RpcClient) {
  // No provider: a map covering every known OAuth provider.
  const all = await client.authStatus();
  const statuses = all.statuses as Record<string, { configured?: boolean }>;
  if (!statuses || typeof statuses !== "object") {
    throw new Error(`expected statuses map: ${JSON.stringify(all)}`);
  }
  for (const provider of ["anthropic", "openai-codex", "github-copilot"]) {
    if (!(provider in statuses)) {
      throw new Error(
        `auth_status missing known provider ${provider}: ${JSON.stringify(statuses)}`,
      );
    }
  }

  // Specific provider with no credential: not configured.
  const before = await client.authStatus("anthropic");
  if ((before.status as { configured?: boolean }).configured !== false) {
    throw new Error(`expected anthropic unconfigured: ${JSON.stringify(before)}`);
  }

  // auth_path must be absolute.
  const relativeError = await client.expectError("configure", {
    auth_path: "relative/auth.json",
  });
  if (!/absolute/i.test(relativeError)) {
    throw new Error(`unexpected auth_path error: ${JSON.stringify(relativeError)}`);
  }

  // File-backed auth: a credential on disk is reflected by auth_status.
  const authFile = `/tmp/pi-agent-daemon-e2e-auth-${crypto.randomUUID()}.json`;
  await Deno.writeTextFile(
    authFile,
    JSON.stringify({ anthropic: { type: "api_key", key: "stored-key" } }),
  );
  try {
    await client.configureAuthPath(authFile);
    const after = await client.authStatus("anthropic");
    if ((after.status as { configured?: boolean }).configured !== true) {
      throw new Error(
        `expected anthropic configured from file: ${JSON.stringify(after)}`,
      );
    }
  } finally {
    await safeRemove(authFile);
  }
}

async function connectWithRetry(
  socketPath: string,
  daemon: Deno.ChildProcess,
  output: ProcessOutput,
): Promise<RpcClient> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    const status = await pollStatus(daemon);
    if (status) {
      await output.done;
      throw new Error(
        `daemon exited before accepting connections: ${status.code}\n` +
          formatOutput(output),
      );
    }

    try {
      const conn = await Deno.connect({ transport: "unix", path: socketPath });
      const client = new RpcClient(conn);
      await client.ready();
      return client;
    } catch (err) {
      lastError = err;
      await delay(100);
    }
  }

  throw new Error(
    `failed to connect to daemon within ${STARTUP_TIMEOUT_MS}ms: ${lastError}\n` +
      formatOutput(output),
  );
}

async function assertDaemonExited(process: Deno.ChildProcess, output: ProcessOutput) {
  const status = await Promise.race([
    process.status,
    delay(5_000).then(() => undefined),
  ]);
  if (!status) {
    throw new Error("daemon did not exit after shutdown");
  }
  if (!status.success) {
    await output.done;
    throw new Error(`daemon exited with ${status.code}\n${formatOutput(output)}`);
  }
}

async function stopProcess(process: Deno.ChildProcess, output: ProcessOutput) {
  const status = await Promise.race([
    process.status,
    delay(250).then(() => undefined),
  ]);
  if (!status) {
    process.kill("SIGTERM");
    await process.status.catch(() => undefined);
  }
  await output.done;
}

async function pollStatus(
  process: Deno.ChildProcess,
): Promise<Deno.CommandStatus | undefined> {
  return await Promise.race([
    process.status,
    delay(0).then(() => undefined),
  ]);
}

interface ProcessOutput {
  stdout: CapturedOutput;
  stderr: CapturedOutput;
  done: Promise<void>;
}

interface CapturedOutput {
  snapshot(): string;
  done: Promise<void>;
}

function captureProcessOutput(process: Deno.ChildProcess): ProcessOutput {
  const stdout = captureOutput(process.stdout);
  const stderr = captureOutput(process.stderr);
  return {
    stdout,
    stderr,
    done: Promise.all([stdout.done, stderr.done]).then(() => {}),
  };
}

function captureOutput(stream: ReadableStream<Uint8Array>): CapturedOutput {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let output = "";

  const done = (async () => {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          output += decoder.decode();
          return;
        }
        output += decoder.decode(result.value, { stream: true });
      }
    } catch (err) {
      output += `\n[output capture failed: ${err}]\n`;
    }
  })();

  return {
    snapshot: () => output,
    done,
  };
}

function formatOutput(output: ProcessOutput): string {
  return [
    "daemon stdout:",
    trimOutput(output.stdout.snapshot()),
    "daemon stderr:",
    trimOutput(output.stderr.snapshot()),
  ].join("\n");
}

function trimOutput(output: string): string {
  const trimmed = output.trim();
  return trimmed || "<empty>";
}

async function safeRemove(path: string) {
  try {
    await Deno.remove(path);
  } catch {
    // absent
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const fakeProvider = startFakeOpenAIProvider();
  const socketPath = `/tmp/pi-agent-daemon-e2e-${crypto.randomUUID()}.sock`;
  const daemon = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "src/main.ts",
      "serve",
      "--socket",
      socketPath,
    ],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const output = captureProcessOutput(daemon);

  let client: RpcClient | undefined;

  try {
    client = await connectWithRetry(socketPath, daemon, output);
    await client.configure(fakeProvider.baseUrl);
    const sessionId = await client.createSession();
    const response = await client.prompt(sessionId, "Return the e2e sentinel.");

    if (!response.events.includes(EXPECTED_TEXT)) {
      throw new Error(
        `missing streamed sentinel: ${JSON.stringify(response.events)}`,
      );
    }
    if (response.result !== EXPECTED_TEXT) {
      throw new Error(`unexpected final response: ${JSON.stringify(response.result)}`);
    }
    if (fakeProvider.requests.length < 1) {
      throw new Error(
        `expected at least one provider request, got ${fakeProvider.requests.length}`,
      );
    }

    for (const providerRequest of fakeProvider.requests) {
      if (providerRequest.model !== TEST_MODEL) {
        throw new Error(`unexpected provider model: ${providerRequest.model}`);
      }
      if (providerRequest.stream !== true) {
        throw new Error("expected streaming chat-completions request");
      }
    }

    const unknownProviderError = await client.expectError("auth_login", {
      provider: "definitely-not-a-provider",
    });
    if (!/provider/i.test(unknownProviderError)) {
      throw new Error(
        `unexpected auth_login error: ${JSON.stringify(unknownProviderError)}`,
      );
    }

    const missingProviderError = await client.expectError("auth_login", {});
    if (!/provider/i.test(missingProviderError)) {
      throw new Error(
        `unexpected auth_login error: ${JSON.stringify(missingProviderError)}`,
      );
    }

    const unknownPromptError = await client.expectError("auth_input", {
      prompt_id: 999999,
      value: "nope",
    });
    if (!/unknown prompt/i.test(unknownPromptError)) {
      throw new Error(
        `unexpected auth_input error: ${JSON.stringify(unknownPromptError)}`,
      );
    }

    await checkAuthStatusAndPath(client);

    await client.disposeSession(sessionId);
    await client.shutdown();
    await assertDaemonExited(daemon, output);
    console.log("e2e ok");
  } finally {
    client?.close();
    fakeProvider.shutdown();
    await safeRemove(socketPath);
    await stopProcess(daemon, output);
  }
}

await main();
