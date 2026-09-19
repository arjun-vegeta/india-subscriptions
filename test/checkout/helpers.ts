import type { CheckoutDocument, CheckoutElement, CheckoutEnv, CheckoutParentNode, CheckoutWindow } from '../../src/checkout/index.js';

export class FakeElement implements CheckoutElement {
  readonly attributes: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly listeners: Record<string, Array<() => void>> = {};
  submitCalls = 0;
  readonly submit?: () => void;

  constructor(readonly tag: string) {
    if (tag === 'form') {
      this.submit = () => {
        this.submitCalls += 1;
      };
    }
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  appendChild(child: unknown): unknown {
    if (child instanceof FakeElement) this.children.push(child);
    return child;
  }
  addEventListener(type: string, listener: () => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  fire(type: string): void {
    for (const listener of this.listeners[type] ?? []) listener();
  }
}

export type ScriptBehaviour = 'load' | 'error' | 'manual';

export class FakeParent implements CheckoutParentNode {
  readonly appended: FakeElement[] = [];
  constructor(private readonly onAppend?: (el: FakeElement) => void) {}
  appendChild(child: unknown): unknown {
    if (child instanceof FakeElement) {
      this.appended.push(child);
      this.onAppend?.(child);
    }
    return child;
  }
}

export interface FakeBrowser {
  env: CheckoutEnv;
  win: CheckoutWindow & Record<string, unknown>;
  doc: CheckoutDocument;
  assigned: string[];
  head: FakeParent;
  body: FakeParent;
  /** Every <script> that was injected. */
  scripts: () => FakeElement[];
  forms: () => FakeElement[];
}

/**
 * A recording window/document. When a <script> is appended it behaves per
 * `behaviour` (asynchronously, like a real network load); on 'load' it runs
 * `onScriptLoad(url)` so a test can install the gateway global.
 */
export function createFakeBrowser(options: {
  behaviour?: ScriptBehaviour;
  onScriptLoad?: (url: string, win: FakeBrowser['win']) => void;
} = {}): FakeBrowser {
  const assigned: string[] = [];
  const win: FakeBrowser['win'] = { location: { assign: (url: string) => void assigned.push(url) } };
  const head = new FakeParent((script) => {
    if (script.tag !== 'script') return;
    const behaviour = options.behaviour ?? 'load';
    if (behaviour === 'manual') return;
    queueMicrotask(() => {
      if (behaviour === 'load') {
        options.onScriptLoad?.(script.attributes['src'] ?? '', win);
        script.fire('load');
      } else {
        script.fire('error');
      }
    });
  });
  const body = new FakeParent();
  const doc: CheckoutDocument = { createElement: (tag) => new FakeElement(tag), head, body };
  return {
    env: { window: win, document: doc },
    win,
    doc,
    assigned,
    head,
    body,
    scripts: () => head.appended.filter((el) => el.tag === 'script'),
    forms: () => body.appended.filter((el) => el.tag === 'form'),
  };
}

/** A fake Razorpay Standard Checkout constructor that records what it is given. */
export class FakeRazorpay {
  static instances: FakeRazorpay[] = [];
  readonly handlers: Record<string, (response: unknown) => void> = {};
  opened = 0;
  closed = 0;
  constructor(readonly options: Record<string, unknown>) {
    FakeRazorpay.instances.push(this);
  }
  on(event: string, handler: (response: unknown) => void): void {
    this.handlers[event] = handler;
  }
  open(): void {
    this.opened += 1;
  }
  close(): void {
    this.closed += 1;
  }
}
