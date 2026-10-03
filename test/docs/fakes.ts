/**
 * Stand-ins used to EXECUTE the documentation's samples: a loader that runs a sample's TypeScript with the real library
 * behind `india-subscriptions`, and a tiny Express whose routes the tests call directly. Only Express's shape is faked;
 * every line of the samples' own code, and the library, is real.
 */
import { createRequire } from 'node:module';
import { posix } from 'node:path';
import ts from 'typescript';

type Handler = (request: FakeRequest, response: FakeResponse, next: () => void) => unknown;

export interface FakeRequest {
  body: unknown;
  rawBody: Buffer;
  headers: Record<string, string>;
  params: Record<string, string>;
}

export class FakeResponse {
  statusCode = 200;
  body: unknown = undefined;
  sent = false;
  redirectedTo: string | undefined;
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  json(body: unknown): this {
    this.body = body;
    this.sent = true;
    return this;
  }
  send(body?: unknown): this {
    this.body = body;
    this.sent = true;
    return this;
  }
  sendStatus(code: number): this {
    this.statusCode = code;
    this.sent = true;
    return this;
  }
  redirect(url: string): void {
    this.redirectedTo = url;
    this.sent = true;
  }
}

interface StackEntry {
  method?: string;
  path?: string;
  handlers: Handler[];
}

export interface FakeApp {
  stack: StackEntry[];
  use(...handlers: Handler[]): FakeApp;
  get(path: string, ...handlers: Handler[]): FakeApp;
  post(path: string, ...handlers: Handler[]): FakeApp;
  listen(): unknown;
  /** Runs a request through the stack in registration order, like Express does. */
  dispatch(method: string, path: string, input: { body?: string; headers?: Record<string, string> }): Promise<FakeResponse>;
}

export interface FakeExpress {
  (): FakeApp;
  json(): Handler;
  raw(): Handler;
  urlencoded(): Handler;
  /** Every app the sample created, in order. */
  apps: FakeApp[];
}

export function fakeExpress(): FakeExpress {
  const apps: FakeApp[] = [];
  const express = ((): FakeApp => {
    const stack: StackEntry[] = [];
    const app: FakeApp = {
      stack,
      use: (...handlers) => (stack.push({ handlers }), app),
      get: (path, ...handlers) => (stack.push({ method: 'GET', path, handlers }), app),
      post: (path, ...handlers) => (stack.push({ method: 'POST', path, handlers }), app),
      listen: () => ({}),
      async dispatch(method, path, input) {
        const request: FakeRequest = {
          body: undefined,
          rawBody: Buffer.from(input.body ?? ''),
          headers: input.headers ?? {},
          params: {},
        };
        const response = new FakeResponse();
        for (const entry of stack) {
          if (entry.method !== undefined && (entry.method !== method || entry.path !== path)) continue;
          for (const handler of entry.handlers) {
            let advanced = false;
            await handler(request, response, () => {
              advanced = true;
            });
            if (response.sent) return response;
            if (!advanced) return response;
          }
        }
        response.statusCode = 404;
        return response;
      },
    };
    apps.push(app);
    return app;
  }) as FakeExpress;
  express.apps = apps;
  express.json = (): Handler => (request, _response, next) => {
    request.body = JSON.parse(request.rawBody.toString('utf8'));
    next();
  };
  express.raw = (): Handler => (request, _response, next) => {
    request.body = request.rawBody;
    next();
  };
  express.urlencoded = (): Handler => (request, _response, next) => {
    request.body = Object.fromEntries(new URLSearchParams(request.rawBody.toString('utf8')));
    next();
  };
  return express;
}

/** Runs TypeScript sources as CommonJS modules, resolving `./x`, `../x` and `@/x` among them and the rest from `externals`. */
export class SampleLoader {
  private readonly cache = new Map<string, Record<string, unknown>>();
  private readonly nodeRequire = createRequire(import.meta.url);

  constructor(
    private readonly files: Map<string, string>,
    private readonly externals: Record<string, unknown>,
  ) {}

  private resolve(from: string, specifier: string): string | undefined {
    let target: string;
    if (specifier.startsWith('@/')) target = specifier.slice(2);
    else if (specifier.startsWith('.')) target = posix.normalize(posix.join(posix.dirname(from), specifier));
    else return undefined;
    for (const candidate of [target, `${target}.ts`, `${target}/index.ts`]) if (this.files.has(candidate)) return candidate;
    throw new Error(`cannot resolve "${specifier}" from ${from}`);
  }

  load(name: string): Record<string, unknown> {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const source = this.files.get(name);
    if (source === undefined) throw new Error(`no sample file ${name}`);
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    const module = { exports: {} as Record<string, unknown> };
    this.cache.set(name, module.exports);
    const require = (specifier: string): unknown => {
      const local = this.resolve(name, specifier);
      if (local) return this.load(local);
      if (specifier in this.externals) return this.externals[specifier];
      if (specifier.startsWith('node:')) return this.nodeRequire(specifier);
      throw new Error(`sample ${name} imports "${specifier}", which the test does not provide`);
    };
    new Function('exports', 'require', 'module', outputText)(module.exports, require, module);
    return module.exports;
  }
}
