import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { ErrorCode, Provider } from '../../constants.js';
import { safeEqual } from '../../crypto.js';
import { SubscriptionError } from '../../errors.js';
import { toUnixSeconds } from '../../time.js';
import {
  ASSERTION_LIFETIME_SECONDS,
  GOOGLE_ISSUERS,
  JWK_FORMAT,
  JWK_KEY_TYPE_RSA,
  JWKS_DEFAULT_MAX_AGE_SECONDS,
  JWKS_MIN_MAX_AGE_SECONDS,
  JWKS_REFETCH_INTERVAL_MS,
  JWT_ALGORITHM,
  JWT_TYPE,
  PUSH_AUTH_SCHEME,
  PUSH_TOKEN_CLOCK_SKEW_SECONDS,
  RS256_NODE_ALGORITHM,
  TOKEN_FALLBACK_LIFETIME_SECONDS,
  TOKEN_REFRESH_MARGIN_MS,
} from './constants.js';
import {
  JwtHeaderSchema,
  PushTokenClaimsSchema,
  type GoogleTokenResponse,
  type Jwk,
  type PushTokenClaims,
} from './schemas.js';

export function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export interface AssertionInput {
  clientEmail: string;
  privateKey: KeyObject;
  /** `private_key_id` of the key, sent as the `kid` header. */
  privateKeyId?: string;
  scope: string;
  /** The token endpoint: the `aud` of the assertion. */
  audience: string;
  now: Date;
}

/**
 * The signed JWT Google's token endpoint exchanges for an access token: header `{alg: RS256, typ: JWT, kid?}`, claims
 * `iss` (the service account e-mail), `scope`, `aud`, `iat`, `exp` (one hour later, the longest allowed), signed with
 * RSASSA-PKCS1-v1_5 SHA-256 and base64url encoded. [https://developers.google.com/identity/protocols/oauth2/service-account]
 */
export function signAssertion(input: AssertionInput): string {
  const issuedAt = toUnixSeconds(input.now);
  const header = {
    alg: JWT_ALGORITHM,
    typ: JWT_TYPE,
    ...(input.privateKeyId !== undefined ? { kid: input.privateKeyId } : {}),
  };
  const claims = {
    iss: input.clientEmail,
    scope: input.scope,
    aud: input.audience,
    exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
    iat: issuedAt,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = sign(RS256_NODE_ALGORITHM, Buffer.from(signingInput, 'utf8'), input.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

/** The instant (epoch milliseconds) at which an access token should be replaced: its `expires_in` minus a safety margin. */
export function tokenRefreshAt(response: GoogleTokenResponse, nowMs: number): number {
  const lifetimeMs = (response.expires_in ?? TOKEN_FALLBACK_LIFETIME_SECONDS) * 1000;
  const margin = Math.min(TOKEN_REFRESH_MARGIN_MS, lifetimeMs / 2);
  return nowMs + lifetimeMs - margin;
}

interface CachedToken {
  token: string;
  refreshAtMs: number;
}

/**
 * Keeps one access token per provider instance. The token is reused until `tokenRefreshAt`, measured with the injected
 * clock; concurrent callers share ONE in-flight token request; `invalidate(token)` drops the cached token only when it is
 * still the one that was rejected. The token lives in a private field: invisible to `JSON.stringify`, `console.log` and
 * spreads, and nothing here puts it into an error.
 */
export class GoogleTokenManager {
  readonly #fetchToken: () => Promise<GoogleTokenResponse>;
  readonly #now: () => Date;
  #cached: CachedToken | undefined;
  #inflight: Promise<string> | undefined;

  constructor(fetchToken: () => Promise<GoogleTokenResponse>, now: () => Date) {
    this.#fetchToken = fetchToken;
    this.#now = now;
  }

  async getToken(): Promise<string> {
    const cached = this.#cached;
    if (cached && this.#now().getTime() < cached.refreshAtMs) return cached.token;
    if (this.#inflight) return this.#inflight;
    const request = this.#renew().finally(() => {
      if (this.#inflight === request) this.#inflight = undefined;
    });
    this.#inflight = request;
    return request;
  }

  invalidate(rejected: string): void {
    if (this.#cached?.token === rejected) this.#cached = undefined;
  }

  async #renew(): Promise<string> {
    const response = await this.#fetchToken();
    const nowMs = this.#now().getTime();
    const refreshAtMs = tokenRefreshAt(response, nowMs);
    this.#cached = refreshAtMs > nowMs ? { token: response.access_token, refreshAtMs } : undefined;
    return response.access_token;
  }
}

// ---------------------------------------------------------------------------
// Pub/Sub push authentication
// ---------------------------------------------------------------------------

export interface JwksFetch {
  keys: Jwk[];
  /** The `max-age` of the response, in seconds, when it named one. */
  maxAgeSeconds: number | undefined;
}

export interface PushVerifierOptions {
  /** The audience the push subscription was created with. */
  audience: string;
  /** The e-mail of the push subscription's authentication service account. */
  serviceAccountEmail: string;
  fetchJwks: () => Promise<JwksFetch>;
  now: () => Date;
}

function badToken(why: string): SubscriptionError {
  return new SubscriptionError(ErrorCode.SignatureInvalid, `${Provider.GooglePlay} push token rejected: ${why}`, {
    provider: Provider.GooglePlay,
  });
}

function decodeJson(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Verifies the OIDC token Pub/Sub puts in `Authorization: Bearer` on every authenticated push: RS256 signature against
 * Google's published keys (cached by their `Cache-Control`, refetched once, at most once a minute, for an unknown `kid`),
 * `iss`, `aud` equal to the configured audience, `exp`, `email` equal to the configured service account and
 * `email_verified` true. Every failure is `SIGNATURE_INVALID`; a failure to fetch the keys keeps its own error code
 * (the request failed, the token was not judged), so Pub/Sub's retry brings the push back.
 */
export class PushTokenVerifier {
  readonly #options: PushVerifierOptions;
  #keys = new Map<string, KeyObject>();
  #expiresAtMs = 0;
  #fetchedAtMs = 0;

  constructor(options: PushVerifierOptions) {
    this.#options = options;
  }

  async verify(authorization: string | undefined): Promise<PushTokenClaims> {
    const token = this.#bearer(authorization);
    const parts = token.split('.');
    if (parts.length !== 3) throw badToken('not a JWT');
    const [headerPart = '', claimsPart = '', signaturePart = ''] = parts;

    const header = JwtHeaderSchema.safeParse(decodeJson(headerPart));
    if (!header.success) throw badToken('unreadable header');
    // The algorithm is fixed, never taken from the token: `none` and HMAC tokens are refused.
    if (header.data.alg !== JWT_ALGORITHM) throw badToken(`algorithm ${header.data.alg} is not ${JWT_ALGORITHM}`);
    if (!header.data.kid) throw badToken('no key id');

    const key = await this.#keyFor(header.data.kid);
    if (!key) throw badToken('signed with a key Google does not publish');
    let valid = false;
    try {
      valid = verify(RS256_NODE_ALGORITHM, Buffer.from(`${headerPart}.${claimsPart}`, 'utf8'), key, Buffer.from(signaturePart, 'base64url'));
    } catch {
      valid = false;
    }
    if (!valid) throw badToken('signature does not match');

    const claims = PushTokenClaimsSchema.safeParse(decodeJson(claimsPart));
    if (!claims.success) throw badToken('unreadable claims');
    this.#checkClaims(claims.data);
    return claims.data;
  }

  #bearer(authorization: string | undefined): string {
    const prefix = `${PUSH_AUTH_SCHEME.toLowerCase()} `;
    if (!authorization || !authorization.toLowerCase().startsWith(prefix)) throw badToken('no bearer token');
    const token = authorization.slice(prefix.length).trim();
    if (token === '') throw badToken('no bearer token');
    return token;
  }

  #checkClaims(claims: PushTokenClaims): void {
    const nowSeconds = toUnixSeconds(this.#options.now());
    if (!GOOGLE_ISSUERS.includes(claims.iss)) throw badToken('issuer is not Google');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.some((audience) => safeEqual(audience, this.#options.audience))) throw badToken('audience does not match');
    if (claims.exp + PUSH_TOKEN_CLOCK_SKEW_SECONDS <= nowSeconds) throw badToken('token has expired');
    if (claims.iat !== undefined && claims.iat !== null && claims.iat - PUSH_TOKEN_CLOCK_SKEW_SECONDS > nowSeconds) {
      throw badToken('token is issued in the future');
    }
    const verified = claims.email_verified === true || claims.email_verified === 'true';
    if (!verified) throw badToken('e-mail is not verified');
    if (!claims.email || !safeEqual(claims.email.toLowerCase(), this.#options.serviceAccountEmail.toLowerCase())) {
      throw badToken('e-mail does not match the push service account');
    }
  }

  async #keyFor(kid: string): Promise<KeyObject | undefined> {
    const nowMs = this.#options.now().getTime();
    if (nowMs >= this.#expiresAtMs) await this.#refresh(nowMs);
    const cached = this.#keys.get(kid);
    if (cached) return cached;
    // Unknown key id: Google may have rotated its keys. Look again, but not on every forged token.
    if (nowMs - this.#fetchedAtMs >= JWKS_REFETCH_INTERVAL_MS) {
      await this.#refresh(nowMs);
      return this.#keys.get(kid);
    }
    return undefined;
  }

  async #refresh(nowMs: number): Promise<void> {
    const fetched = await this.#options.fetchJwks();
    const keys = new Map<string, KeyObject>();
    for (const jwk of fetched.keys) {
      if (jwk.kty !== JWK_KEY_TYPE_RSA || !jwk.n || !jwk.e) continue;
      try {
        keys.set(jwk.kid, createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: JWK_FORMAT }));
      } catch {
        // A key that cannot be read is not used; the others still are.
      }
    }
    const maxAge = Math.max(fetched.maxAgeSeconds ?? JWKS_DEFAULT_MAX_AGE_SECONDS, JWKS_MIN_MAX_AGE_SECONDS);
    this.#keys = keys;
    this.#fetchedAtMs = nowMs;
    this.#expiresAtMs = nowMs + maxAge * 1000;
  }
}
