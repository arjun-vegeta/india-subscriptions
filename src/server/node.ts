/**
 * Adapts the Fetch handler to `node:http`. The request body is streamed
 * through untouched, so webhook signatures verify over the exact bytes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { ErrorCode, HeaderName } from '../constants.js';
import { ERROR_HTTP_STATUS, HeaderValue, ServerErrorCode, SERVER_ERROR_HTTP_STATUS } from './constants.js';
import { createHandler, type HandlerOptions } from './handler.js';

const BODYLESS_METHODS: readonly string[] = ['GET', 'HEAD'];
const LOCAL_ORIGIN = 'http://localhost';

function toRequest(incoming: IncomingMessage, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const method = incoming.method ?? 'GET';
  const url = `${LOCAL_ORIGIN}${incoming.url ?? '/'}`;
  if (BODYLESS_METHODS.includes(method)) return new Request(url, { method, headers, signal });
  return new Request(url, {
    method,
    headers,
    signal,
    body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
    duplex: 'half',
  } as RequestInit);
}

async function writeResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  const bytes = Buffer.from(await response.arrayBuffer());
  outgoing.end(bytes);
}

function writeFailure(outgoing: ServerResponse, status: number, code: string): void {
  if (outgoing.headersSent) {
    outgoing.destroy();
    return;
  }
  outgoing.statusCode = status;
  outgoing.setHeader(HeaderName.ContentType, HeaderValue.JsonUtf8);
  outgoing.end(JSON.stringify({ error: { code, message: 'The request could not be processed', retryable: false } }));
}

/** A `node:http` server that serves the service. Call `listen` (or `server.listen`) to start it. */
export function createNodeServer(options: HandlerOptions): Server {
  const handler = createHandler(options);
  return createServer((incoming, outgoing) => {
    const aborted = new AbortController();
    outgoing.on('close', () => aborted.abort());
    let request: Request;
    try {
      request = toRequest(incoming, aborted.signal);
    } catch {
      writeFailure(outgoing, ERROR_HTTP_STATUS[ErrorCode.Validation], ErrorCode.Validation);
      return;
    }
    handler(request)
      .then((response) => writeResponse(response, outgoing))
      .catch(() =>
        writeFailure(outgoing, SERVER_ERROR_HTTP_STATUS[ServerErrorCode.Internal], ServerErrorCode.Internal),
      );
  });
}

export interface ListenOptions {
  /** 0 picks a free port. Default 0. */
  port?: number;
  /** Default loopback only: pass `0.0.0.0` deliberately to accept outside connections. */
  host?: string;
}

export interface RunningServer {
  server: Server;
  host: string;
  port: number;
  /** `http://host:port`, without a trailing slash. */
  url: string;
  close: () => Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';

/** Starts listening and resolves once the socket is bound. */
export function listen(server: Server, options: ListenOptions = {}): Promise<RunningServer> {
  const host = options.host ?? DEFAULT_HOST;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        host,
        port,
        url: `http://${host}:${port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
            server.closeAllConnections();
          }),
      });
    });
  });
}
