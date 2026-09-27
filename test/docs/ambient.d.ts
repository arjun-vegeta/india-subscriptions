/**
 * Minimal declarations for the third-party modules the documentation's samples import, so the samples can be
 * type-checked without installing the frameworks. They describe only what the samples use, with the same shapes as
 * the real packages.
 */
declare module 'express' {
  import type { IncomingHttpHeaders } from 'node:http';

  export interface Request {
    // `any` as in @types/express: the body is whatever the body-parsing middleware produced.
    body: any;
    headers: IncomingHttpHeaders;
    params: Record<string, string>;
  }
  export interface Response {
    status(code: number): Response;
    json(body: unknown): Response;
    send(body?: unknown): Response;
    sendStatus(code: number): Response;
    redirect(url: string): void;
    type(mime: string): Response;
    setHeader(name: string, value: string): Response;
  }
  export type NextFunction = (error?: unknown) => void;
  export type Handler = (request: Request, response: Response, next: NextFunction) => unknown;
  export interface Application {
    use(...handlers: Handler[]): Application;
    get(path: string, ...handlers: Handler[]): Application;
    post(path: string, ...handlers: Handler[]): Application;
    listen(port: number, callback?: () => void): unknown;
  }
  interface Express {
    (): Application;
    json(options?: { limit?: string | number }): Handler;
    raw(options?: { type?: string | string[]; limit?: string | number }): Handler;
    urlencoded(options?: { extended?: boolean }): Handler;
  }
  const express: Express;
  export default express;
  export type { Express };
}
