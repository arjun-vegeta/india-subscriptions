import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/constants.js';
import {
  assertChecksum,
  generateChecksum,
  generateParamsChecksum,
  generateSalt,
  jsonMemberText,
  paramsPayload,
  verifyChecksum,
  verifyParamsChecksum,
} from '../../src/providers/paytm/checksum.js';
import { KEY, SALT, independentSign, independentVerify } from './helpers.js';

/*
 * Paytm publishes no merchant key and no test vector, so none of its documented signatures can be reproduced. The
 * known-answer vectors below were computed OUTSIDE this code base, with `sha256sum` and `openssl enc -aes-128-cbc -K <key hex>
 * -iv 40404040262626262323232324242424 -base64` (the algorithm of `paytmchecksum@1.5.1`, read line by line). The first is the
 * vector of the fact sheet (§2.5), computed there by a second implementation and `openssl`.
 */
const VECTOR_KEY = 'abcdefghijklmnop';

const VECTORS = [
  {
    name: 'a JSON body (fact sheet §2.5)',
    key: VECTOR_KEY,
    payload: '{"mid":"MID123","subsId":"7271","txnAmount":"2000.00"}',
    salt: 'AbC+',
    sha256: 'f26f1b56ec7f39df4ba51a751238ab6dea6b0ba9322c25be67640077e473ca9d',
    checksum: 'Zj6ojWPw+E0C13tcNq3E1xuzI2kQOUXkpqyZ/1NWnkWnVNAc3iLyoqnGzRdPdJsOvrmv1kXTdYHH7jRJZOf1tPAz1wcZYg5fx762JE4cGlY=',
  },
  {
    name: 'a key-value payload (the fact sheet param-map example)',
    key: VECTOR_KEY,
    payload: '1||INR|M1|O1|TXN_SUCCESS|1.00|4|2',
    salt: 'x/Y9',
    sha256: '588d703b49b81078751f744f55555bec7374128644ca8de8ddab531c93382541',
    checksum: 'gp6BBOxdNeibCbt4Ro5fNoRUx23THL6nu45kcqplnj9jFThrCky3WxdVSkZOJlId0YybqdYeJKm9SHZ6EcDBYz3XmxnDe8lhmK4RPwskXdw=',
  },
  {
    name: 'a nested JSON body under another key and a salt of base64 symbols',
    key: 'a1B2c3D4e5F6g7H8',
    payload: '{"mid":"INTEG1","orderId":"ORD_1","txnAmount":{"value":"1.00","currency":"INR"}}',
    salt: 'Zz+/',
    sha256: 'be6626973f1c9d4fce6018aad5890024a97582c8d4abb8fc1bb468c1b8499ea6',
    checksum: 'lJSct2l2IiLJpz26wFoLYOVoBSx+qLi3ylg7geMzyhxCBurF8ZhUQzGiCdZOjZ9S0Da1KmUzXQjlrClLz0SRysd8hNyOAL3NMNn6rtIjwoc=',
  },
] as const;

describe('Paytm checksum: known answers', () => {
  for (const vector of VECTORS) {
    it(`generates the openssl-computed checksum of ${vector.name}`, () => {
      expect(generateChecksum(vector.payload, vector.key, vector.salt)).toBe(vector.checksum);
      expect(vector.checksum).toHaveLength(108);
    });

    it(`verifies the openssl-computed checksum of ${vector.name}`, () => {
      expect(verifyChecksum(vector.payload, vector.key, vector.checksum)).toBe(true);
      // The plaintext is sha256(payload|salt) in hex followed by the salt: 68 characters.
      expect(createHash('sha256').update(`${vector.payload}|${vector.salt}`).digest('hex')).toBe(vector.sha256);
    });

    it(`the independent implementation in the test helpers agrees on ${vector.name}`, () => {
      expect(independentSign(vector.payload, vector.key, vector.salt)).toBe(vector.checksum);
      expect(independentVerify(vector.payload, vector.key, vector.checksum)).toBe(true);
    });
  }
});

describe('Paytm checksum: generate and verify', () => {
  const payload = '{"mid":"M","orderId":"O"}';

  it('uses a fresh random 4-character salt each time, and every checksum verifies', () => {
    const first = generateChecksum(payload, KEY);
    const second = generateChecksum(payload, KEY);
    expect(first).not.toBe(second);
    for (const checksum of [first, second]) {
      expect(checksum).toHaveLength(108);
      expect(verifyChecksum(payload, KEY, checksum)).toBe(true);
      expect(independentVerify(payload, KEY, checksum)).toBe(true);
    }
  });

  it('draws the salt from 3 random bytes in base64: always 4 characters of the base64 alphabet', () => {
    for (let i = 0; i < 50; i += 1) expect(generateSalt()).toMatch(/^[A-Za-z0-9+/]{4}$/);
  });

  it('takes an injected salt, so a signature is reproducible', () => {
    expect(generateChecksum(payload, KEY, SALT)).toBe(generateChecksum(payload, KEY, SALT));
    expect(generateChecksum(payload, KEY, SALT)).toBe(independentSign(payload, KEY, SALT));
  });

  it('refuses a salt that is not 4 printable ASCII characters', () => {
    for (const salt of ['abc', 'abcde', 'abéd', '']) expect(() => generateChecksum(payload, KEY, salt)).toThrowError(/salt/);
  });

  it('rejects a changed payload (one character, one added space)', () => {
    const checksum = generateChecksum(payload, KEY, SALT);
    expect(verifyChecksum('{"mid":"M","orderId":"P"}', KEY, checksum)).toBe(false);
    expect(verifyChecksum('{"mid":"M", "orderId":"O"}', KEY, checksum)).toBe(false);
    expect(verifyChecksum(`${payload} `, KEY, checksum)).toBe(false);
  });

  it('rejects the wrong merchant key', () => {
    const checksum = generateChecksum(payload, KEY, SALT);
    expect(verifyChecksum(payload, 'zzzzzzzzzzzzzzzz', checksum)).toBe(false);
  });

  it('rejects a damaged, truncated, empty or non-base64 checksum without throwing', () => {
    const checksum = generateChecksum(payload, KEY, SALT);
    const flipped = `${checksum.slice(0, 40)}${checksum.charAt(40) === 'A' ? 'B' : 'A'}${checksum.slice(41)}`;
    for (const bad of [flipped, checksum.slice(0, 64), checksum.slice(0, 107), '', '!!!!', `${checksum}AAAA`]) {
      expect(verifyChecksum(payload, KEY, bad)).toBe(false);
    }
  });

  it('refuses a key that is not 16 bytes, without putting the key in the message', () => {
    for (const key of ['short', 'a-key-that-is-much-longer-than-sixteen', '']) {
      let message = '';
      let code = '';
      try {
        generateChecksum(payload, key, SALT);
      } catch (error) {
        message = (error as Error).message;
        code = (error as { code: string }).code;
      }
      expect(code).toBe(ErrorCode.Config);
      expect(message).toContain('16 bytes');
      if (key !== '') expect(message).not.toContain(key);
    }
  });

  it('counts the key in bytes, not characters (a multi-byte character is two bytes)', () => {
    expect(() => generateChecksum(payload, 'abcdefghijklmné', SALT)).not.toThrow();
    expect(() => generateChecksum(payload, 'abcdefghijklmnoé', SALT)).toThrowError(/16 bytes/);
  });

  it('hashes the payload as UTF-8: a non-ASCII payload matches the independent implementation', () => {
    const text = '{"firstName":"Zoë अश्वीन"}';
    expect(generateChecksum(text, KEY, SALT)).toBe(independentSign(text, KEY, SALT));
  });

  it('assertChecksum throws SIGNATURE_INVALID for a missing, wrong or foreign checksum and accepts a genuine one', () => {
    const checksum = generateChecksum(payload, KEY, SALT);
    expect(() => assertChecksum(payload, KEY, checksum, 'webhook')).not.toThrow();
    for (const bad of [undefined, null, '', 'nonsense', generateChecksum('other', KEY, SALT)]) {
      expect(() => assertChecksum(payload, KEY, bad, 'webhook')).toThrowError(expect.objectContaining({ code: ErrorCode.SignatureInvalid }));
    }
  });
});

describe('Paytm checksum: key-value posts', () => {
  const fields = { MID: 'M1', ORDERID: 'O1', TXNAMOUNT: '1.00', STATUS: 'TXN_SUCCESS', BANKTXNID: null, CURRENCY: 'INR', b: '2', B: '1', _x: '4' };

  it('signs the values in the order of the sorted names (UTF-16 code units), null as empty (fact sheet §2.5)', () => {
    expect(paramsPayload(fields)).toBe('1||INR|M1|O1|TXN_SUCCESS|1.00|4|2');
  });

  it('puts mixed-case names after every upper-case name, as the docs warn (subStatus, vpa)', () => {
    expect(paramsPayload({ vpa: 'v', subStatus: 's', STATUS: 'ACTIVE', SUBS_ID: '1', ORDERID: 'o' })).toBe('o|ACTIVE|1|s|v');
  });

  it('never signs CHECKSUMHASH, whatever it holds, and does not modify the caller\'s object', () => {
    const withChecksum = { ...fields, CHECKSUMHASH: 'whatever' };
    expect(paramsPayload(withChecksum)).toBe('1||INR|M1|O1|TXN_SUCCESS|1.00|4|2');
    expect(Object.keys(withChecksum)).toContain('CHECKSUMHASH');
  });

  it('generates and verifies, tolerating a CHECKSUMHASH field in the params', () => {
    const checksum = generateParamsChecksum(fields, VECTOR_KEY, 'x/Y9');
    expect(checksum).toBe(VECTORS[1].checksum);
    expect(verifyParamsChecksum({ ...fields, CHECKSUMHASH: checksum }, VECTOR_KEY, checksum)).toBe(true);
  });

  it('fails when one value changes, one is added, or one is removed', () => {
    const checksum = generateParamsChecksum(fields, VECTOR_KEY, 'x/Y9');
    expect(verifyParamsChecksum({ ...fields, TXNAMOUNT: '2.00' }, VECTOR_KEY, checksum)).toBe(false);
    expect(verifyParamsChecksum({ ...fields, EXTRA: 'x' }, VECTOR_KEY, checksum)).toBe(false);
    const { STATUS: _removed, ...without } = fields;
    expect(verifyParamsChecksum(without, VECTOR_KEY, checksum)).toBe(false);
  });
});

describe('jsonMemberText: the exact characters of a member', () => {
  it('returns the member as written, compact or pretty-printed', () => {
    const compact = '{"head":{"signature":"s"},"body":{"a":"1","b":{"c":[1,2,{"d":"}"}]}}}';
    expect(jsonMemberText(compact, 'body')).toBe('{"a":"1","b":{"c":[1,2,{"d":"}"}]}}');
    const pretty = '{\n  "head": {"signature": "s"},\n  "body": {\n    "a": "1"\n  }\n}';
    expect(jsonMemberText(pretty, 'body')).toBe('{\n    "a": "1"\n  }');
  });

  it('is not fooled by braces, quotes and escapes inside strings or by a key of the same name nested deeper', () => {
    const text = '{"head":{"body":"inner"},"note":"say \\"body\\": {","body":{"x":"a\\\\"}}';
    expect(jsonMemberText(text, 'body')).toBe('{"x":"a\\\\"}');
  });

  it('reads scalars and arrays, and answers undefined for a missing member or text that is not an object', () => {
    expect(jsonMemberText('{"a":12,"b":[1,2],"c":true}', 'b')).toBe('[1,2]');
    expect(jsonMemberText('{"a":12,"b":[1,2],"c":true}', 'a')).toBe('12');
    expect(jsonMemberText('{"a":12,"b":[1,2],"c":true}', 'c')).toBe('true');
    expect(jsonMemberText('{"a":1}', 'body')).toBeUndefined();
    for (const text of ['[1]', 'x', '', '{"a"', '{"a":', '{"a":{"b":1']) expect(jsonMemberText(text, 'a')).toBeUndefined();
  });
});
