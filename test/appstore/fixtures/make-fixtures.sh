#!/bin/sh
# Regenerates the test certificate chains and keys in pki/ with the openssl CLI (OpenSSL 3.4 or newer: it needs
# `-not_before` / `-not_after`). The chains copy the shape of the one Apple documents for signed data: a root, an
# intermediate that carries the Worldwide Developer Relations extension (1.2.840.113635.100.6.2.1) and a leaf that
# carries the receipt-signing extension (1.2.840.113635.100.6.11.1). The tests run with a fixed clock inside the
# validity windows below, so regenerating needs no other change. Everything here is test material, not a secret.
set -eu
cd "$(dirname "$0")/pki"
rm -f ./*.pem ./*.p8 ./*.cnf ./*.csr ./*.srl

WWDR_OID=1.2.840.113635.100.6.2.1
RECEIPT_OID=1.2.840.113635.100.6.11.1

ec() { # ec <curve> <out.key>  (PKCS#8 PEM)
  openssl genpkey -algorithm EC -pkeyopt "ec_paramgen_curve:$1" -out "$2" 2>/dev/null
}

root() { # root <name> <subject CN>
  ec P-384 "$1.key"
  cat > "$1.cnf" <<CNF
[ext]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
CNF
  openssl req -new -key "$1.key" -subj "/CN=$2/O=Test Apple Inc./C=US" -out "$1.csr"
  openssl x509 -req -in "$1.csr" -signkey "$1.key" -not_before 20200101000000Z -not_after 20460101000000Z \
    -extfile "$1.cnf" -extensions ext -out "$1.pem" 2>/dev/null
}

intermediate() { # intermediate <name> <subject CN> <issuer name> <ca true|false> <with oid yes|no>
  ec P-384 "$1.key"
  {
    echo "[ext]"
    echo "basicConstraints = critical,CA:$(echo "$4" | tr a-z A-Z)"
    echo "keyUsage = critical,keyCertSign,cRLSign"
    [ "$5" = yes ] && echo "$WWDR_OID = ASN1:NULL"
    true
  } > "$1.cnf"
  openssl req -new -key "$1.key" -subj "/CN=$2/O=Test Apple Inc./C=US" -out "$1.csr"
  openssl x509 -req -in "$1.csr" -CA "$3.pem" -CAkey "$3.key" -not_before 20240101000000Z -not_after 20450101000000Z \
    -extfile "$1.cnf" -extensions ext -out "$1.pem" 2>/dev/null
}

leaf() { # leaf <name> <subject CN> <issuer name> <not_before> <not_after> <with oid yes|no>
  ec P-256 "$1.key"
  {
    echo "[ext]"
    echo "basicConstraints = critical,CA:FALSE"
    echo "keyUsage = critical,digitalSignature"
    [ "$6" = yes ] && echo "$RECEIPT_OID = ASN1:NULL"
    true
  } > "$1.cnf"
  openssl req -new -key "$1.key" -subj "/CN=$2/O=Test Apple Inc./C=US" -out "$1.csr"
  openssl x509 -req -in "$1.csr" -CA "$3.pem" -CAkey "$3.key" -not_before "$4" -not_after "$5" \
    -extfile "$1.cnf" -extensions ext -out "$1.pem" 2>/dev/null
}

# The good chain.
root root "Test Root CA"
intermediate intermediate "Test Worldwide Developer Relations CA" root true yes
leaf leaf "Test Receipt Signing" intermediate 20260101000000Z 20270101000000Z yes

# A second, unrelated chain: signed data from it must not verify against the first root.
root other-root "Other Root CA"
intermediate other-intermediate "Other Worldwide Developer Relations CA" other-root true yes
leaf other-leaf "Other Receipt Signing" other-intermediate 20260101000000Z 20270101000000Z yes

# A leaf that expired before the tests' clock, and one that is not valid yet.
leaf expired-leaf "Test Receipt Signing (expired)" intermediate 20250101000000Z 20260601000000Z yes
leaf future-leaf "Test Receipt Signing (future)" intermediate 20270101000000Z 20280101000000Z yes

# A leaf without the receipt-signing extension, and an intermediate without the WWDR extension.
leaf no-oid-leaf "Test Leaf without extension" intermediate 20260101000000Z 20270101000000Z no
intermediate no-oid-intermediate "Test Intermediate without extension" root true no
leaf no-oid-intermediate-leaf "Test Receipt Signing" no-oid-intermediate 20260101000000Z 20270101000000Z yes

# An intermediate that is not a CA, with a leaf under it.
intermediate not-ca-intermediate "Test Intermediate that is not a CA" root false yes
leaf not-ca-leaf "Test Receipt Signing" not-ca-intermediate 20260101000000Z 20270101000000Z yes

# App Store Connect style keys: PKCS#8 .p8 files (P-256) for API requests and for promotional offers.
ec P-256 api-key.p8
ec P-256 offer-key.p8

rm -f ./*.cnf ./*.csr ./*.srl
