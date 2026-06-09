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

export class AgentDaemon {
  private sessions = new Map<string, SessionHandle>();
  private nextSessionId = 1;
  private authStorage = AuthStorage.inMemory();
  private modelRegistry = ModelRegistry.inMemory(this.authStorage);

  configure(w: RpcWriter, id: number, params: Record<string, unknown>) {
    const authData = params.auth as Record<string, unknown> | undefined;
    if (authData) {
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
