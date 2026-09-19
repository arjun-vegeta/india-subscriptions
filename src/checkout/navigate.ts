import type { z } from 'zod';
import { CheckoutKind, ErrorCode } from '../constants.js';
import { parseInput, SubscriptionError } from '../errors.js';
import { FormPostCheckoutSchema, RedirectCheckoutSchema } from '../schemas.js';
import { CheckoutStatus, DomAttribute, DomTag, FormMethod, InputType } from './constants.js';
import { append, assertWebUrl, resolveEnv, type CheckoutEnv } from './env.js';
import type { CheckoutOutcome } from './schemas.js';

export type RedirectCheckout = z.infer<typeof RedirectCheckoutSchema>;
export type FormPostCheckout = z.infer<typeof FormPostCheckoutSchema>;

/** `redirect`: send the customer to the gateway's URL. */
export function redirectTo(instruction: RedirectCheckout, env?: Partial<CheckoutEnv>): CheckoutOutcome {
  const parsed = parseInput(RedirectCheckoutSchema, instruction, `${CheckoutKind.Redirect} checkout instruction`);
  const { window: win } = resolveEnv(env);
  assertWebUrl(parsed.url, 'redirect URL');
  win.location.assign(parsed.url);
  return { status: CheckoutStatus.Redirecting };
}

/**
 * `form_post`: builds a hidden POST form and submits it. Every field becomes a
 * hidden `<input>` whose name and value are set through the DOM, never spliced
 * into HTML, so quotes, angle brackets, ampersands and unicode arrive intact.
 * Fields are posted exactly as given: the server already hashed them.
 */
export function submitForm(instruction: FormPostCheckout, env?: Partial<CheckoutEnv>): CheckoutOutcome {
  const parsed = parseInput(FormPostCheckoutSchema, instruction, `${CheckoutKind.FormPost} checkout instruction`);
  const { document: doc } = resolveEnv(env);
  assertWebUrl(parsed.url, 'form action URL');
  const parent = doc.body ?? doc.head;
  if (!parent) {
    throw new SubscriptionError(ErrorCode.Config, 'The document has no <body> to attach the checkout form to');
  }

  const form = doc.createElement(DomTag.Form);
  form.setAttribute(DomAttribute.Method, FormMethod.Post);
  form.setAttribute(DomAttribute.Action, parsed.url);
  // Read submit() before adding inputs: a field named "submit" would otherwise shadow it.
  const submit = form.submit;
  if (typeof submit !== 'function') {
    throw new SubscriptionError(ErrorCode.Config, 'The created form element cannot be submitted');
  }
  for (const [name, value] of Object.entries(parsed.fields)) {
    const input = doc.createElement(DomTag.Input);
    input.setAttribute(DomAttribute.Type, InputType.Hidden);
    input.setAttribute(DomAttribute.Name, name);
    input.setAttribute(DomAttribute.Value, value);
    append(form, input);
  }
  append(parent, form);
  submit.call(form);
  return { status: CheckoutStatus.Redirecting };
}
