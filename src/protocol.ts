export const DAEMON_NAME = "pi-agent-daemon";
export const DAEMON_VERSION = "0.79.0";
export const PI_AGENT_VERSION = "0.79.0";
export const PROTOCOL_VERSION = "4.0.0";

export const DEFAULT_TOOLS = [
  "bash",
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
];

export interface RpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcWriter {
  send(obj: Record<string, unknown>): void;
  flush(): Promise<void>;
  sendEvent(id: number, event: string, data?: Record<string, unknown>): void;
  sendResult(id: number, result?: Record<string, unknown>): void;
  sendError(id: number, message: string): void;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  api?: string;
  headers?: Record<string, string>;
  models: Array<{
    id: string;
    name?: string;
    reasoning?: boolean;
    input?: string[];
    cost?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
    contextWindow?: number;
    maxTokens?: number;
    compat?: Record<string, unknown>;
  }>;
}

export type Transport = "unix" | "tcp";

export function readyFrame(transport: Transport): Record<string, unknown> {
  return {
    ready: true,
    daemon: DAEMON_NAME,
    version: DAEMON_VERSION,
    pi_agent_version: PI_AGENT_VERSION,
    protocol_version: PROTOCOL_VERSION,
    transport,
  };
}
