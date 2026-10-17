import { X509Certificate, createHash } from 'node:crypto';
import { ErrorCode, Provider, type Environment } from '../../constants.js';
import { SubscriptionError, parseResponse } from '../../errors.js';
import { VerificationFailure } from './certificates.js';
import {
  APPLE_ROOT_CA_G3_PEM,
  APPLE_ROOT_CA_G3_SHA256,
  APPSTORE_ENVIRONMENTS,
  AppStoreEnvironment,
  EXTERNAL_PURCHASE_SANDBOX_PREFIX,
} from './constants.js';
import { verifySignedData } from './jws.js';
import {
  NotificationPayloadSchema,
  RenewalInfoPayloadSchema,
  TransactionPayloadSchema,
  type NotificationPayload,
  type RenewalInfoPayload,
  type TransactionPayload,
} from './schemas.js';

export interface VerifierOptions {
  bundleId: string;
  environment: Environment;
  /** Production notifications name the app's Apple id; it must equal this. Not checked in the sandbox, which omits it. */
  appAppleId?: number | undefined;
  /** PEM certificates that replace Apple Root CA - G3. */
  rootCertificates?: readonly string[] | undefined;
  now: () => Date;
}

function configError(message: string): SubscriptionError {
  return new SubscriptionError(ErrorCode.Config, `Invalid ${Provider.AppStore} config: ${message}`, { provider: Provider.AppStore });
}

/** Apple Root CA - G3, parsed, after checking it is the certificate the pinned fingerprint names. */
function pinnedAppleRoot(): X509Certificate {
  const certificate = new X509Certificate(APPLE_ROOT_CA_G3_PEM);
  if (createHash('sha256').update(certificate.raw).digest('hex') !== APPLE_ROOT_CA_G3_SHA256) {
    throw configError('the built-in Apple Root CA - G3 does not match its pinned fingerprint');
  }
  return certificate;
}

/**
 * Verifies and decodes the signed data the App Store produces: transactions, renewal information and notifications. Everything
 * that fails (the chain, the signature, the bundle id, the environment, the app's Apple id) is `SIGNATURE_INVALID` and nothing
 * is read from the payload. Data whose signature verifies but whose payload does not have the documented shape is
 * `UNEXPECTED_RESPONSE`.
 */
export class AppStoreVerifier {
  readonly #bundleId: string;
  readonly #environment: AppStoreEnvironment;
  readonly #appAppleId: number | undefined;
  readonly #roots: readonly X509Certificate[];
  readonly #now: () => Date;

  constructor(options: VerifierOptions) {
    this.#bundleId = options.bundleId;
    this.#environment = APPSTORE_ENVIRONMENTS[options.environment];
    this.#appAppleId = options.appAppleId;
    this.#now = options.now;
    if (options.rootCertificates === undefined) {
      this.#roots = [pinnedAppleRoot()];
    } else {
      this.#roots = options.rootCertificates.map((pem) => {
        try {
          return new X509Certificate(pem);
        } catch {
          throw configError('rootCertificates must be PEM certificates');
        }
      });
    }
  }

  /** Verifies the signature and returns the payload, or throws `SIGNATURE_INVALID`. */
  private open(signed: string, what: string): unknown {
    try {
      return verifySignedData(signed, this.#roots, this.#now());
    } catch (cause) {
      if (!(cause instanceof VerificationFailure)) throw cause;
      throw new SubscriptionError(ErrorCode.SignatureInvalid, `${Provider.AppStore} ${what} did not verify: ${cause.message}`, {
        provider: Provider.AppStore,
      });
    }
  }

  private refuse(what: string, why: string): SubscriptionError {
    return new SubscriptionError(ErrorCode.SignatureInvalid, `${Provider.AppStore} ${what} is not for this app: ${why}`, {
      provider: Provider.AppStore,
    });
  }

  private assertEnvironment(what: string, environment: string | null | undefined): void {
    if (environment?.toLowerCase() !== this.#environment.toLowerCase()) {
      throw this.refuse(what, `its environment is not ${this.#environment}`);
    }
  }

  private assertBundle(what: string, bundleId: string | null | undefined): void {
    if (bundleId !== this.#bundleId) throw this.refuse(what, 'its bundle id is not the configured one');
  }

  /** `JWSTransaction`: the bundle id and the environment must be this app's. */
  transaction(signed: string): TransactionPayload {
    const what = 'signed transaction';
    const payload = parseResponse(TransactionPayloadSchema, this.open(signed, what), what, Provider.AppStore);
    this.assertBundle(what, payload.bundleId);
    this.assertEnvironment(what, payload.environment);
    return payload;
  }

  /** `JWSRenewalInfo`: it names no bundle id, so only the environment is checked. */
  renewalInfo(signed: string): RenewalInfoPayload {
    const what = 'signed renewal information';
    const payload = parseResponse(RenewalInfoPayloadSchema, this.open(signed, what), what, Provider.AppStore);
    this.assertEnvironment(what, payload.environment);
    return payload;
  }

  /**
   * The `signedPayload` of a notification. The bundle id and the environment are read from whichever object carries them
   * (`data`, `summary`, `externalPurchaseToken`, `appData`, `unclaimInfo`), and in production the app's Apple id must be the
   * configured one, as in Apple's library. The nested signed transaction and renewal information are verified by the caller.
   */
  notification(signedPayload: string): NotificationPayload {
    const what = 'notification';
    const payload = parseResponse(NotificationPayloadSchema, this.open(signedPayload, what), what, Provider.AppStore);
    const info = this.appInfo(payload);
    if (info === undefined) throw this.refuse(what, 'it names no app');
    this.assertBundle(what, info.bundleId);
    this.assertEnvironment(what, info.environment);
    if (this.#environment === AppStoreEnvironment.Production && info.appAppleId !== this.#appAppleId) {
      throw this.refuse(what, 'its app Apple id is not the configured one');
    }
    return payload;
  }

  private appInfo(payload: NotificationPayload): { bundleId?: string | null; environment?: string | null; appAppleId?: number | null } | undefined {
    const object = payload.data ?? payload.summary ?? payload.appData ?? payload.unclaimInfo;
    if (object) return object;
    const token = payload.externalPurchaseToken;
    if (!token) return undefined;
    // A token has no environment field: a sandbox token's id starts with SANDBOX.
    return {
      bundleId: token.bundleId,
      appAppleId: token.appAppleId,
      environment: token.externalPurchaseId.startsWith(EXTERNAL_PURCHASE_SANDBOX_PREFIX)
        ? AppStoreEnvironment.Sandbox
        : AppStoreEnvironment.Production,
    };
  }
}
