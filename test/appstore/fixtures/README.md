# App Store test fixtures

## `pki/`: generated

`make-fixtures.sh` builds the certificate chains and keys with the `openssl` CLI (OpenSSL 3.4 or newer). The tests sign
their JWS with these keys using `node:crypto` and trust `pki/root.pem` through the adapter's `rootCertificates` option.
The files are test material, committed as generated; run the script to make new ones (the validity windows are fixed, so
nothing else changes).

| File | What it is |
|---|---|
| `root`, `intermediate`, `leaf` | The good chain, shaped like Apple's: the intermediate carries `1.2.840.113635.100.6.2.1`, the leaf `1.2.840.113635.100.6.11.1` |
| `other-root`, `other-intermediate`, `other-leaf` | A second, unrelated chain (the "wrong root" case) |
| `expired-leaf`, `future-leaf` | A leaf that ended before the tests' clock, and one that starts after it |
| `no-oid-leaf`, `no-oid-intermediate`, `no-oid-intermediate-leaf` | A leaf and an intermediate without Apple's extensions |
| `not-ca-intermediate`, `not-ca-leaf` | An intermediate that is not a certificate authority |
| `api-key.p8`, `offer-key.p8` | PKCS #8 P-256 keys in the format App Store Connect hands out |

## `apple/`: published by Apple

Copied from Apple's App Store Server Library for Node.js, https://github.com/apple/app-store-server-library-node
(commit b71d9c70aa4a4a5efea258d530f50733a7916af3), which is MIT licensed (`apple/LICENSE.txt`):

- `models/*.json`: the library's sample decoded payloads and API responses (`tests/resources/models/`): a transaction, renewal
  information, notifications, a subscription statuses response, a history response, error bodies. The tests sign the decoded
  payloads with the generated chain and set `environment` to `Sandbox`, since the library's samples say `LocalTesting`.
- `mock_signed_data/`: signed data the library ships, made with its own test certificate authority (`certs/testCA.der`,
  valid 2023-01-05 to 2033-01-02) (`tests/resources/mock_signed_data/`, `tests/resources/certs/testCA.der`).
- `certs/real-apple-chain.json`: the real Apple Root CA - G3, Worldwide Developer Relations intermediate and receipt-signing
  leaf the library's `tests/unit-tests/jws_verification.test.ts` verifies, with the effective date it uses (2025-10-31).
