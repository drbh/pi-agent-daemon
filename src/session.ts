import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_TOOLS, ProviderConfig, RpcWriter } from "./protocol.ts";

interface SessionHandle {
  session: AgentSession;
  loader: unknown;
}

interface AgentSession {
  subscribe(cb: (event: AgentRuntimeEvent) => void): () => void;
  prompt(message: string): Promise<void>;
  dispose(): void;
}

interface AgentRuntimeEvent {
  type: string;
  turnIndex?: number;
  assistantMessageEvent?: {
    type: string;
    delta?: string;
  };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

interface ModelRecord {
  id: string;
  provider?: string;
}

// OAuth callback shapes, mirrored locally from @earendil-works/pi-ai so the
// daemon does not need a direct dependency on that package's type exports.
interface OAuthAuthInfo {
  url: string;
  instructions?: string;
}

interface OAuthDeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
}

interface OAuthPrompt {
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
}

interface OAuthSelectOption {
  id: string;
  label: string;
}

interface OAuthSelectPrompt {
  message: string;
  options: OAuthSelectOption[];
}

interface OAuthLoginCallbacks {
  onAuth: (info: OAuthAuthInfo) => void;
  onDeviceCode: (info: OAuthDeviceCodeInfo) => void;
  onProgress?: (message: string) => void;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onSelect: (prompt: OAuthSelectPrompt) => Promise<string | undefined>;
  signal?: AbortSignal;
}

interface PendingInput {
  loginId: number;
  resolve: (value: string | undefined) => void;
  reject: (error: Error) => void;
}

export class AgentDaemon {
  private sessions = new Map<string, SessionHandle>();
  private nextSessionId = 1;
  private authStorage = AuthStorage.inMemory();
  private modelRegistry = ModelRegistry.inMemory(this.authStorage);
  private nextAuthId = 1;
  private activeLogins = new Map<
    number,
    { controller: AbortController; w: RpcWriter }
  >();
  private pendingInputs = new Map<number, PendingInput>();

  configure(w: RpcWriter, id: number, params: Record<string, unknown>) {
    const authPath = params.auth_path as string | undefined;
    const authData = params.auth as Record<string, unknown> | undefined;

    if (authPath !== undefined) {
      // File-backed storage owns persistence + token refresh + locking. It
      // takes precedence over an inline `auth` map: the file is the durable
      // source of truth, and `auth_login` writes straight through to it.
      if (!authPath.startsWith("/")) {
        w.sendError(id, "auth_path must be an absolute path");
        return;
      }
      this.authStorage = AuthStorage.create(authPath);
      this.modelRegistry = ModelRegistry.inMemory(this.authStorage);
      console.error(`Using file-backed auth at: ${authPath}`);
    } else if (authData) {
      this.authStorage = AuthStorage.inMemory(authData as never);
      this.modelRegistry = ModelRegistry.inMemory(this.authStorage);
      console.error(`Loaded auth for: ${Object.keys(authData).join(", ")}`);
    }

    const providers = params.providers as
      | Record<string, ProviderConfig>
      | undefined;

    if (providers) {
      for (const [name, config] of Object.entries(providers)) {
        let apiKey = config.apiKey;
        if (apiKey.startsWith("$") && !apiKey.startsWith("$$")) {
          const envName = apiKey.slice(1);
          apiKey = Deno.env.get(envName) || apiKey;
        }

        this.modelRegistry.registerProvider(name, {
          baseUrl: config.baseUrl,
          apiKey,
          api: config.api || "openai-completions",
          headers: config.headers,
          models: config.models.map((m) => ({
            id: m.id,
            name: m.name || m.id,
            reasoning: m.reasoning ?? false,
            input: m.input || ["text"],
            cost: m.cost || {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
            contextWindow: m.contextWindow || 128000,
            maxTokens: m.maxTokens || 8192,
            compat: m.compat,
          })),
        } as never);
      }
    }

    w.sendResult(id, { configured: true });
  }

  /**
   * Report auth status without exposing credential values. With a `provider`,
   * returns that provider's status; otherwise returns a map covering every
   * provider that has a credential plus every known OAuth provider. Lets a
   * client render "Connected as …" without parsing the on-disk auth schema.
   */
  authStatus(w: RpcWriter, id: number, params: Record<string, unknown>) {
    const provider = params.provider as string | undefined;
    if (provider) {
      w.sendResult(id, {
        provider,
        status: this.authStorage.getAuthStatus(provider),
      });
      return;
    }

    const providers = new Set<string>(this.authStorage.list());
    for (const p of this.authStorage.getOAuthProviders()) {
      providers.add(p.id);
    }

    const statuses: Record<string, unknown> = {};
    for (const name of providers) {
      statuses[name] = this.authStorage.getAuthStatus(name);
    }
    w.sendResult(id, { statuses });
  }

  /**
   * Start an OAuth login flow for a provider (e.g. "anthropic", "openai-codex",
   * "github-copilot"). The flow runs in the background so this connection's read
   * loop stays responsive: push callbacks are streamed as events, and any
   * interactive prompt/selection is answered by a follow-up `auth_input` request.
   * On success the result carries the new credential plus the full auth map so
   * the caller can persist it and re-`configure` later.
   *
   * An optional `method` selects a provider's login method up front (e.g.
   * "device_code" for openai-codex), short-circuiting the `auth_select`
   * round-trip so that — for providers that offer device code — the client can
   * complete login as a pure one-directional event stream. Providers that never
   * present a choice (e.g. anthropic) ignore it.
   */
  authLogin(w: RpcWriter, id: number, params: Record<string, unknown>) {
    const provider = params.provider as string | undefined;
    if (!provider) {
      w.sendError(id, "auth_login requires a 'provider'");
      return;
    }

    const method = params.method as string | undefined;

    const controller = new AbortController();
    this.activeLogins.set(id, { controller, w });

    // Capture the storage in use now; configure() may swap it concurrently.
    const storage = this.authStorage;

    const callbacks: OAuthLoginCallbacks = {
      onAuth: (info) =>
        w.sendEvent(id, "auth_url", {
          url: info.url,
          instructions: info.instructions ?? null,
        }),
      onDeviceCode: (info) =>
        w.sendEvent(id, "device_code", {
          user_code: info.userCode,
          verification_uri: info.verificationUri,
          interval_seconds: info.intervalSeconds ?? null,
          expires_in_seconds: info.expiresInSeconds ?? null,
        }),
      onProgress: (message) => w.sendEvent(id, "auth_progress", { message }),
      onPrompt: (prompt) =>
        this.requestInput(w, id, "auth_prompt", {
          message: prompt.message,
          placeholder: prompt.placeholder ?? null,
          allow_empty: prompt.allowEmpty ?? false,
        }).then((value) => {
          if (value === undefined) {
            throw new Error("login cancelled");
          }
          return value;
        }),
      onSelect: (prompt) => {
        if (method !== undefined) {
          if (!prompt.options.some((option) => option.id === method)) {
            const ids = prompt.options.map((option) => option.id).join(", ");
            return Promise.reject(
              new Error(`unknown login method: ${method} (expected one of: ${ids})`),
            );
          }
          return Promise.resolve(method);
        }
        return this.requestInput(w, id, "auth_select", {
          message: prompt.message,
          options: prompt.options,
        });
      },
      signal: controller.signal,
    };

    storage
      .login(provider as never, callbacks as never)
      .then(() => {
        w.sendResult(id, {
          provider,
          credential: storage.get(provider) ?? null,
          auth: storage.getAll(),
        });
      })
      .catch((err: unknown) => {
        w.sendError(id, err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        this.activeLogins.delete(id);
        this.rejectInputsForLogin(id, "login finished");
      });
  }

  /** Answer a pending `auth_prompt`/`auth_select`. A null/absent value cancels. */
  authInput(w: RpcWriter, id: number, params: Record<string, unknown>) {
    const promptId = params.prompt_id as number | undefined;
    const pending = promptId === undefined
      ? undefined
      : this.pendingInputs.get(promptId);
    if (promptId === undefined || !pending) {
      w.sendError(id, `unknown prompt: ${promptId}`);
      return;
    }

    this.pendingInputs.delete(promptId);
    const value = params.value;
    pending.resolve(value === undefined || value === null ? undefined : String(value));
    w.sendResult(id, {});
  }

  /** Abort an in-flight login started with the given `login_id`. */
  authCancel(w: RpcWriter, id: number, params: Record<string, unknown>) {
    const loginId = params.login_id as number | undefined;
    if (loginId !== undefined) {
      this.activeLogins.get(loginId)?.controller.abort();
      this.rejectInputsForLogin(loginId, "login cancelled");
    }
    w.sendResult(id, {});
  }

  /** Tear down any logins owned by a connection that has gone away. */
  cancelLoginsForWriter(w: RpcWriter) {
    for (const [loginId, login] of this.activeLogins) {
      if (login.w === w) {
        login.controller.abort();
        this.rejectInputsForLogin(loginId, "connection closed");
      }
    }
  }

  private requestInput(
    w: RpcWriter,
    loginId: number,
    event: string,
    data: Record<string, unknown>,
  ): Promise<string | undefined> {
    const promptId = this.nextAuthId++;
    w.sendEvent(loginId, event, { ...data, prompt_id: promptId });
    return new Promise((resolve, reject) => {
      this.pendingInputs.set(promptId, { loginId, resolve, reject });
    });
  }

  private rejectInputsForLogin(loginId: number, reason: string) {
    for (const [promptId, pending] of this.pendingInputs) {
      if (pending.loginId === loginId) {
        this.pendingInputs.delete(promptId);
        pending.reject(new Error(reason));
      }
    }
  }

  async createSession(
    w: RpcWriter,
    id: number,
    params: Record<string, unknown>,
  ) {
    const cwd = (params.cwd as string) || Deno.cwd();
    const agentDir = getAgentDir();
    const systemPrompt = params.system_prompt as string | undefined;
    const tools = (params.tools as string[]) || DEFAULT_TOOLS;

    const model = this.findModel(params.model as string | undefined);
    if (model.error) {
      w.sendError(id, model.error);
      return;
    }

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      ...(systemPrompt
        ? {
          systemPromptOverride: () => systemPrompt,
          appendSystemPromptOverride: () => [],
        }
        : {}),
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd,
      resourceLoader: loader,
      tools,
      sessionManager: SessionManager.inMemory(),
      modelRegistry: this.modelRegistry,
      authStorage: this.authStorage,
      ...(model.value ? { model: model.value as never } : {}),
    } as never);

    const sessionId = `s${this.nextSessionId++}`;
    this.sessions.set(sessionId, { session: session as AgentSession, loader });

    w.sendResult(id, { session_id: sessionId });
  }

  async prompt(
    w: RpcWriter,
    id: number,
    params: Record<string, unknown>,
  ) {
    const sessionId = params.session_id as string;
    const message = params.message as string;

    const handle = this.sessions.get(sessionId);
    if (!handle) {
      w.sendError(id, `unknown session: ${sessionId}`);
      return;
    }

    let fullText = "";

    const unsub = handle.session.subscribe((event) => {
      switch (event.type) {
        case "turn_start":
          w.sendEvent(id, "turn_start", { turn_index: event.turnIndex });
          break;
        case "message_update":
          if (event.assistantMessageEvent?.type === "text_delta") {
            const delta = event.assistantMessageEvent.delta || "";
            fullText += delta;
            w.sendEvent(id, "text_delta", { delta });
          }
          break;
        case "tool_execution_start":
          w.sendEvent(id, "tool_start", {
            tool_call_id: event.toolCallId,
            tool_name: event.toolName,
            args: event.args,
          });
          break;
        case "tool_execution_end":
          w.sendEvent(id, "tool_end", {
            tool_call_id: event.toolCallId,
            tool_name: event.toolName,
            result: typeof event.result === "string"
              ? event.result
              : JSON.stringify(event.result),
            is_error: event.isError,
          });
          break;
        case "turn_end":
          w.sendEvent(id, "turn_end", { turn_index: event.turnIndex });
          break;
        default:
          break;
      }
    });

    try {
      await handle.session.prompt(message);
      w.sendResult(id, { response: fullText });
    } catch (err) {
      w.sendError(id, err instanceof Error ? err.message : String(err));
    } finally {
      unsub();
      await w.flush();
    }
  }

  disposeSession(
    w: RpcWriter,
    id: number,
    params: Record<string, unknown>,
  ) {
    const sessionId = params.session_id as string;
    const handle = this.sessions.get(sessionId);
    if (handle) {
      handle.session.dispose();
      this.sessions.delete(sessionId);
    }
    w.sendResult(id, {});
  }

  async shutdown(w: RpcWriter, id: number) {
    for (const [, handle] of this.sessions) {
      handle.session.dispose();
    }
    this.sessions.clear();
    w.sendResult(id, {});
    await w.flush();
    setTimeout(() => Deno.exit(0), 50);
  }

  private findModel(modelSpec: string | undefined): {
    value?: unknown;
    error?: string;
  } {
    if (!modelSpec) {
      return {};
    }

    const parts = modelSpec.split("/");
    const model = parts.length === 2
      ? this.modelRegistry.find(parts[0], parts[1])
      : (this.modelRegistry.getAll() as ModelRecord[]).find((m) => m.id === modelSpec);

    if (model) {
      return { value: model };
    }

    const available = this.modelRegistry
      .getAll()
      .map((m: ModelRecord) => `${m.provider}/${m.id}`)
      .join(", ");
    return { error: `model not found: ${modelSpec}. Available: ${available}` };
  }
}
