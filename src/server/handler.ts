/**
 * The HTTP service as a Fetch API handler: `(Request) => Promise<Response>`.
 * It runs on Node, Bun, Deno, Cloudflare Workers and inside framework route
 * handlers. `node.ts` adapts it to `node:http`.
 */
import { ErrorCode, HashAlgorithm, HeaderName, type Provider } from '../constants.js';
import type { Subscriptions } from '../client.js';
import { safeEqual, hash } from '../crypto.js';
import { SubscriptionError, isSubscriptionError, parseInput } from '../errors.js';
import { ProviderSchema } from '../schemas.js';
import {
  BEARER_SCHEME,
  DEFAULT_MAX_BODY_BYTES,
  ERROR_HTTP_STATUS,
  HeaderValue,
  HttpStatus,
  PathParam,
  SERVER_ERROR_HTTP_STATUS,
  ServerErrorCode,
  ServerHeader,
  AuthMode,
} from './constants.js';
import { buildOpenApiDocument } from './openapi.js';
import { routes, type ErrorResponse, type EventsHook, type RouteDefinition } from './routes.js';
import { type SchemaName, namedSchema } from '../schema-registry.js';

export interface HandlerOptions {
  /** The facade the routes call. Configure the gateways (and the billing scheduler) on it. */
  client: Subscriptions;
  /** Clients must send `Authorization: Bearer <apiKey>` on every route except health, the OpenAPI document and gateway webhooks. */
  apiKey?: string;
  /**
   * Serve the protected routes without an API key. This service holds live gateway credentials, so
   * this must be asked for explicitly: without it `createHandler` refuses to start with no `apiKey`.
   */
  allowUnauthenticated?: boolean;
  /** Called with the verified, normalised events of every webhook received at `POST /v1/{provider}/webhooks`. */
  onEvents?: EventsHook;
  /** Mount prefix, e.g. `/billing` when a framework forwards `/billing/*` here. */
  basePath?: string;
  /** Largest request body accepted, in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
}

export type FetchHandler = (request: Request) => Promise<Response>;

interface PathMatch {
  route: RouteDefinition;
  params: Record<string, string>;
}

interface CompiledRoute {
  route: RouteDefinition;
  segments: string[];
}

const PLACEHOLDER = /^\{([^}]+)\}$/;

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

const COMPILED: readonly CompiledRoute[] = routes.map((route) => ({ route, segments: splitPath(route.path) }));

class MalformedPathError extends Error {}

function matchPath(pathSegments: string[]): PathMatch[] {
  const matches: PathMatch[] = [];
  for (const { route, segments } of COMPILED) {
    if (segments.length !== pathSegments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < segments.length; i += 1) {
      const template = segments[i] as string;
      const actual = pathSegments[i] as string;
      const placeholder = PLACEHOLDER.exec(template);
      if (placeholder) {
        try {
          params[placeholder[1] as string] = decodeURIComponent(actual);
        } catch {
          throw new MalformedPathError();
        }
      } else if (template !== actual) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push({ route, params });
  }
  return matches;
}

function normaliseBasePath(basePath: string | undefined): string {
  if (!basePath) return '';
  const trimmed = basePath.replace(/\/+$/, '');
  if (trimmed === '') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function baseHeaders(): Headers {
  const headers = new Headers();
  headers.set(HeaderName.ContentType, HeaderValue.JsonUtf8);
  headers.set(ServerHeader.CacheControl, HeaderValue.NoStore);
  headers.set(ServerHeader.ContentTypeOptions, HeaderValue.NoSniff);
  return headers;
}

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  const headers = baseHeaders();
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  return new Response(JSON.stringify(body), { status, headers });
}

function errorBody(
  code: ErrorResponse['error']['code'],
  message: string,
  details: Partial<Pick<ErrorResponse['error'], 'provider' | 'httpStatus' | 'providerCode'>> = {},
  retryable = false,
): ErrorResponse {
  return { error: { code, message, ...details, retryable } };
}

function serverError(
  code: ServerErrorCode,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return jsonResponse(SERVER_ERROR_HTTP_STATUS[code], errorBody(code, message), extraHeaders);
}

function libraryError(code: ErrorCode, message: string): Response {
  return jsonResponse(ERROR_HTTP_STATUS[code], errorBody(code, message));
}

/** Turns anything thrown into the one error shape. Unknown values never leak their message or stack. */
function toErrorResponse(error: unknown): Response {
  if (isSubscriptionError(error)) {
    return jsonResponse(
      ERROR_HTTP_STATUS[error.code],
      errorBody(
        error.code,
        error.message,
        { provider: error.provider, httpStatus: error.httpStatus, providerCode: error.providerCode },
        error.retryable,
      ),
    );
  }
  return serverError(ServerErrorCode.Internal, 'Internal server error');
}

class PayloadTooLargeError extends Error {}

async function readBodyText(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get(ServerHeader.ContentLength);
  if (declared !== null && Number(declared) > maxBytes) throw new PayloadTooLargeError();
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // `ignoreBOM` keeps a leading BOM in the string: signatures are computed over every byte.
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

const BEARER_PATTERN = new RegExp(`^${BEARER_SCHEME}\\s+(.+)$`, 'i');

/** Compares digests, so neither the key's value nor its length is observable through timing. */
function keyMatches(provided: string, expected: string): boolean {
  return safeEqual(hash(HashAlgorithm.Sha256, provided), hash(HashAlgorithm.Sha256, expected));
}

function isAuthorized(request: Request, apiKey: string): boolean {
  const header = request.headers.get(HeaderName.Authorization);
  if (!header) return false;
  const token = BEARER_PATTERN.exec(header.trim())?.[1];
  return token !== undefined && keyMatches(token.trim(), apiKey);
}

function describeValue(value: string): string {
  return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value);
}

/**
 * Builds the request handler. Throws `CONFIG` unless an `apiKey` is given or `allowUnauthenticated`
 * is passed explicitly: this service holds live gateway credentials.
 */
export function createHandler(options: HandlerOptions): FetchHandler {
  const apiKey = options.apiKey;
  if (!apiKey && options.allowUnauthenticated !== true) {
    throw new SubscriptionError(
      ErrorCode.Config,
      'createHandler needs an apiKey, or allowUnauthenticated: true to serve without one',
    );
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new SubscriptionError(ErrorCode.Config, 'maxBodyBytes must be a positive integer');
  }
  const basePath = normaliseBasePath(options.basePath);
  const { client, onEvents } = options;
  let openApi: unknown;
  const openApiDocument = (): unknown => (openApi ??= buildOpenApiDocument({ serverUrl: basePath || '/' }));

  async function dispatch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    let relative = pathname;
    if (basePath) {
      if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
        return libraryError(ErrorCode.NotFound, 'Not found');
      }
      relative = pathname.slice(basePath.length);
    }

    let matches: PathMatch[];
    try {
      matches = matchPath(splitPath(relative));
    } catch (error) {
      if (error instanceof MalformedPathError) {
        return libraryError(ErrorCode.Validation, 'The path is not valid percent-encoding');
      }
      throw error;
    }
    if (matches.length === 0) return libraryError(ErrorCode.NotFound, 'Not found');

    const match = matches.find((candidate) => candidate.route.method === request.method);
    if (!match) {
      const allowed = [...new Set(matches.map((candidate) => candidate.route.method))].sort().join(', ');
      return serverError(ServerErrorCode.MethodNotAllowed, `Use one of: ${allowed}`, {
        [ServerHeader.Allow]: allowed,
      });
    }
    const { route, params } = match;

    if (route.auth === AuthMode.Bearer && apiKey && !isAuthorized(request, apiKey)) {
      return serverError(ServerErrorCode.Unauthorized, 'Missing or invalid API key', {
        [ServerHeader.WwwAuthenticate]: BEARER_SCHEME,
      });
    }

    let provider: Provider | undefined;
    const rawProvider = params[PathParam.Provider];
    if (rawProvider !== undefined) {
      const parsed = ProviderSchema.safeParse(rawProvider);
      if (!parsed.success) {
        return libraryError(ErrorCode.Validation, `Unknown provider ${describeValue(rawProvider)}`);
      }
      if (!client.providers.includes(parsed.data)) {
        return libraryError(ErrorCode.NotFound, `Provider ${parsed.data} is not configured on this service`);
      }
      provider = parsed.data;
    }

    let body: unknown;
    if (route.requestBody) {
      const text = await readBodyText(request, maxBodyBytes);
      if (route.requestBody.raw) {
        body = text;
      } else if (text.trim() === '') {
        if (route.requestBody.required) {
          return libraryError(ErrorCode.Validation, 'A JSON request body is required');
        }
        body = parseInput(namedSchema(route.requestBody.schema as SchemaName), {}, 'request body', provider);
      } else {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          return libraryError(ErrorCode.Validation, 'The request body is not valid JSON');
        }
        body = parseInput(namedSchema(route.requestBody.schema as SchemaName), json, 'request body', provider);
      }
    }

    const result = await route.handler({
      client,
      provider,
      params,
      body,
      query: new URL(request.url).searchParams,
      request,
      onEvents,
      openApiDocument,
    });
    return jsonResponse(route.response.status, result);
  }

  return async (request) => {
    try {
      return await dispatch(request);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return serverError(ServerErrorCode.PayloadTooLarge, `The request body is over ${maxBodyBytes} bytes`, {
          [ServerHeader.Connection]: HeaderValue.Close,
        });
      }
      return toErrorResponse(error);
    }
  };
}
