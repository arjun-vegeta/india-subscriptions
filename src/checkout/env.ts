import { ErrorCode, type Provider } from '../constants.js';
import { SubscriptionError } from '../errors.js';
import { ALLOWED_URL_PROTOCOLS, DomAttribute, DomEvent, DomTag, GlobalName } from './constants.js';

/**
 * The smallest slices of `window` and `document` the helper uses, so tests
 * (and exotic hosts) can pass fakes. The real `window` and `document` satisfy
 * these structurally.
 */
export interface CheckoutElement {
  setAttribute(name: string, value: string): void;
  appendChild(child: never): unknown;
  addEventListener(type: string, listener: () => void): void;
  /** Present on `<form>` elements. */
  submit?: () => void;
}

export interface CheckoutParentNode {
  appendChild(child: never): unknown;
}

export interface CheckoutDocument {
  createElement(tag: string): CheckoutElement;
  head?: CheckoutParentNode | null;
  body?: CheckoutParentNode | null;
}

export interface CheckoutWindow {
  location: { assign(url: string): void };
}

export interface CheckoutEnv {
  window: CheckoutWindow;
  document: CheckoutDocument;
}

/**
 * `appendChild` is typed `never` in the structural interfaces because the real
 * DOM method is generic over `Node`; this is the one place that bridges it.
 */
export function append(parent: CheckoutParentNode | CheckoutElement, child: CheckoutElement): void {
  parent.appendChild(child as never);
}

/** Uses the page's own `window` / `document` unless `env` overrides them. Throws `CONFIG` without a DOM. */
export function resolveEnv(env?: Partial<CheckoutEnv>): CheckoutEnv {
  const win = env?.window ?? (typeof window === 'undefined' ? undefined : window);
  const doc = env?.document ?? (typeof document === 'undefined' ? undefined : document);
  if (!win || !doc || typeof doc.createElement !== 'function' || !win.location) {
    throw new SubscriptionError(
      ErrorCode.Config,
      'The checkout helper needs a browser: no window/document found. Run it in the customer\'s browser, or pass env.',
    );
  }
  return { window: win, document: doc };
}

/** Reads a property of the window (a gateway script's global) without trusting its type. */
export function readGlobal(win: CheckoutWindow, name: GlobalName): unknown {
  return Reflect.get(win, name);
}

/** Rejects anything but http(s) so a bad instruction cannot navigate to `javascript:` or `data:` URLs. */
export function assertWebUrl(url: string, what: string): void {
  let protocol: string | undefined;
  try {
    protocol = new URL(url).protocol;
  } catch {
    protocol = undefined;
  }
  if (protocol === undefined || !ALLOWED_URL_PROTOCOLS.includes(protocol)) {
    throw new SubscriptionError(ErrorCode.Validation, `Invalid ${what}: only http(s) URLs are allowed`);
  }
}

const loads = new WeakMap<object, Map<string, Promise<void>>>();

/**
 * Loads a script once per document. Concurrent calls for the same URL share
 * one `<script>` element; later calls reuse the result. A failed load is
 * forgotten so the caller can try again. Rejects with `PROVIDER_UNAVAILABLE`.
 */
export async function loadScript(url: string, env?: Partial<CheckoutEnv>, provider?: Provider): Promise<void> {
  const { document: doc } = resolveEnv(env);
  assertWebUrl(url, 'script URL');
  let perDocument = loads.get(doc);
  if (!perDocument) {
    perDocument = new Map();
    loads.set(doc, perDocument);
  }
  const cached = perDocument.get(url);
  if (cached) return cached;


  const pending = new Promise<void>((resolve, reject) => {
    const parent = doc.head ?? doc.body;
    if (!parent) {
      reject(new SubscriptionError(ErrorCode.Config, 'The document has no <head> or <body> to load a script into', { provider }));
      return;
    }
    const script = doc.createElement(DomTag.Script);
    script.setAttribute(DomAttribute.Src, url);
    script.setAttribute(DomAttribute.Async, '');
    script.addEventListener(DomEvent.Load, () => resolve());
    script.addEventListener(DomEvent.Error, () =>
      reject(
        new SubscriptionError(ErrorCode.ProviderUnavailable, `Could not load the gateway script ${url}. Check the network, ad blockers and your Content-Security-Policy.`, {
          provider,
        }),
      ),
    );
    append(parent, script);
  });
  perDocument.set(url, pending);
  pending.catch(() => {
    if (perDocument.get(url) === pending) perDocument.delete(url);
  });
  return pending;
}
