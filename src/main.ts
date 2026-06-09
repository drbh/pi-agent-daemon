import { AgentDaemon } from "./session.ts";
import {
  DAEMON_NAME,
  DAEMON_VERSION,
  readyFrame,
  RpcRequest,
  RpcWriter,
  Transport,
} from "./protocol.ts";

interface ServeOptions {
  socket?: string;
  tcp?: string;
  cwd?: string;
}

class ConnectionWriter implements RpcWriter {
  private queue: Promise<void> = Promise.resolve();
  private encoder = new TextEncoder();

  constructor(private conn: Deno.Conn) {}

  send(obj: Record<string, unknown>) {
    const data = this.encoder.encode(JSON.stringify(obj) + "\n");
    const conn = this.conn;
    this.queue = this.queue.then(async () => {
      try {
        let written = 0;
        while (written < data.length) {
          written += await conn.write(data.subarray(written));
        }
      } catch {
        /* connection closed */
      }
    });
  }

  flush(): Promise<void> {
    return this.queue;
  }

  sendEvent(id: number, event: string, data: Record<string, unknown> = {}) {
    this.send({ id, event, data });
  }

  sendResult(id: number, result: Record<string, unknown> = {}) {
    this.send({ id, result });
  }

  sendError(id: number, message: string) {
    this.send({ id, error: message });
  }
}

async function main(args = Deno.args) {
  const command = args[0];

  if (!command || command === "-h" || command === "--help" || command === "help") {
    printHelp();
    return;
  }

  if (command === "version" || command === "--version" || command === "-V") {
    console.log(`${DAEMON_NAME} ${DAEMON_VERSION}`);
    return;
  }

  if (command === "health") {
    await health(parseServeOptions(args.slice(1)));
    return;
  }

  if (command === "serve") {
    await serve(parseServeOptions(args.slice(1)));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

async function serve(options: ServeOptions) {
  if (options.socket && options.tcp) {
    throw new Error("choose either --socket or --tcp, not both");
  }

  if (options.cwd) {
    Deno.chdir(options.cwd);
  }

  if (options.tcp) {
    await serveTcp(options.tcp);
    return;
  }

  await serveUnix(options.socket || "/tmp/pi-agent.sock");
}

async function serveUnix(socketPath: string) {
  try {
    Deno.removeSync(socketPath);
  } catch {
    /* missing socket is fine */
  }

  const daemon = new AgentDaemon();
  const listener = Deno.listen({ transport: "unix", path: socketPath });
  console.error(`${DAEMON_NAME} listening on ${socketPath}`);
  await acceptLoop(daemon, listener, "unix");
}

async function serveTcp(addr: string) {
  const [hostname, rawPort] = splitHostPort(addr);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`invalid tcp port: ${rawPort}`);
  }

  const daemon = new AgentDaemon();
  const listener = Deno.listen({ hostname, port });
  console.error(`${DAEMON_NAME} listening on ${hostname}:${port}`);
  await acceptLoop(daemon, listener, "tcp");
}

async function acceptLoop(
  daemon: AgentDaemon,
  listener: Deno.Listener,
  transport: Transport,
) {
  for await (const conn of listener) {
    handleConnection(daemon, conn, transport);
  }
}

async function handleConnection(
  daemon: AgentDaemon,
  conn: Deno.Conn,
  transport: Transport,
) {
  const w = new ConnectionWriter(conn);

  w.send(readyFrame(transport));
  await w.flush();

  const buf = new Uint8Array(1024 * 64);
  const decoder = new TextDecoder();
  let leftover = "";

  try {
    while (true) {
      const n = await conn.read(buf);
      if (n === null) {
        break;
      }

      leftover += decoder.decode(buf.subarray(0, n), { stream: true });
      const lines = leftover.split("\n");
      leftover = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        let req: RpcRequest;
        try {
          req = JSON.parse(trimmed);
        } catch {
          w.send({ error: "invalid json", raw: trimmed });
          continue;
        }

        try {
          await dispatch(daemon, w, req);
        } catch (err) {
          w.sendError(req.id, err instanceof Error ? err.message : String(err));
        }
      }
    }
  } catch {
    // Connection reset.
  } finally {
    try {
      conn.close();
    } catch {
      /* connection already closed */
    }
  }
}

async function dispatch(
  daemon: AgentDaemon,
  w: RpcWriter,
  req: RpcRequest,
) {
  const params = req.params || {};

  switch (req.method) {
    case "configure":
      daemon.configure(w, req.id, params);
      break;
    case "create_session":
      await daemon.createSession(w, req.id, params);
      break;
    case "prompt":
      await daemon.prompt(w, req.id, params);
      break;
    case "dispose_session":
      daemon.disposeSession(w, req.id, params);
      break;
    case "shutdown":
      await daemon.shutdown(w, req.id);
      break;
    default:
      w.sendError(req.id, `unknown method: ${req.method}`);
  }
}

async function health(options: ServeOptions) {
  if (options.tcp) {
    const [hostname, rawPort] = splitHostPort(options.tcp);
    const conn = await Deno.connect({ hostname, port: Number(rawPort) });
    await printReadyFrame(conn);
    return;
  }

  const socketPath = options.socket || "/tmp/pi-agent.sock";
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  await printReadyFrame(conn);
}

async function printReadyFrame(conn: Deno.Conn) {
  const buf = new Uint8Array(1024 * 8);
  const n = await conn.read(buf);
  conn.close();
  if (n === null) {
    throw new Error("daemon closed before ready frame");
  }
  console.log(new TextDecoder().decode(buf.subarray(0, n)).trim());
}

function parseServeOptions(args: string[]): ServeOptions {
  const options: ServeOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--socket":
        options.socket = requiredValue(args, ++i, "--socket");
        break;
      case "--tcp":
        options.tcp = requiredValue(args, ++i, "--tcp");
        break;
      case "--cwd":
        options.cwd = requiredValue(args, ++i, "--cwd");
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  return options;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function splitHostPort(addr: string): [string, string] {
  const idx = addr.lastIndexOf(":");
  if (idx < 0) {
    throw new Error(`expected host:port, got: ${addr}`);
  }
  return [addr.slice(0, idx), addr.slice(idx + 1)];
}

function printHelp() {
  console.log(`Usage:
  ${DAEMON_NAME} serve [--socket PATH | --tcp HOST:PORT] [--cwd PATH]
  ${DAEMON_NAME} health [--socket PATH | --tcp HOST:PORT]
  ${DAEMON_NAME} version
`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  }
}
