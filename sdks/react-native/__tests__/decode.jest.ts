import {
  decodeEntitlements,
  decodeEvent,
  decodeEvents,
  decodeOutcome,
  decodeRefundOutcome,
  decodeReturnLinkResult,
} from '../src/decode';
import { failure, session } from './support';

const billingFailure = {
  reason: 'userCanceled',
  responseCode: 1,
  message: 'canceled',
};

describe('decodeOutcome', () => {
  it.each(['completed', 'pending', 'awaitingReturn'])('maps %s', (type) => {
    expect(decodeOutcome({ type, session })).toEqual({ type, session });
  });

  it('maps cancelled with and without a session', () => {
    expect(decodeOutcome({ type: 'cancelled' })).toEqual({ type: 'cancelled' });
    expect(decodeOutcome({ type: 'cancelled', session })).toEqual({
      type: 'cancelled',
      session,
    });
  });

  it('maps unverified', () => {
    expect(
      decodeOutcome({ type: 'unverified', session, reason: 'bad' })
    ).toEqual({
      type: 'unverified',
      session,
      reason: 'bad',
    });
  });

  it.each(['awaitingBackend', 'rejected'])(
    'maps %s with its failure',
    (type) => {
      expect(decodeOutcome({ type, session, failure })).toEqual({
        type,
        session,
        failure,
      });
    }
  );

  it('maps failed with a billing failure', () => {
    expect(
      decodeOutcome({ type: 'failed', session, failure: billingFailure })
    ).toEqual({ type: 'failed', session, failure: billingFailure });
  });

  it('keeps an unknown reason inside a known outcome', () => {
    const odd = { ...failure, reason: 'aReasonFromTheFuture' };
    expect(decodeOutcome({ type: 'rejected', session, failure: odd })).toEqual({
      type: 'rejected',
      session,
      failure: odd,
    });
  });

  it('maps a type it does not know to unknown with the raw name', () => {
    const raw = { type: 'scheduled', session };
    expect(decodeOutcome(raw)).toEqual({
      type: 'unknown',
      name: 'scheduled',
      raw,
    });
  });

  it('maps a known type that lacks what it needs to unknown', () => {
    expect(decodeOutcome({ type: 'completed' })).toMatchObject({
      type: 'unknown',
      name: 'completed',
    });
    expect(decodeOutcome({ type: 'rejected', session })).toMatchObject({
      type: 'unknown',
    });
  });

  it.each([null, undefined, 7, 'completed', [], {}])(
    'does not throw on %p',
    (raw) => {
      expect(decodeOutcome(raw)).toMatchObject({ type: 'unknown', raw });
    }
  );
});

describe('decodeEvent', () => {
  it('maps completed with an iOS transaction id or an Android purchase token', () => {
    expect(
      decodeEvent({ type: 'completed', session, transactionId: '9' })
    ).toEqual({ type: 'completed', session, transactionId: '9' });
    expect(
      decodeEvent({ type: 'completed', session, purchaseToken: 'tok' })
    ).toEqual({ type: 'completed', session, purchaseToken: 'tok' });
    expect(decodeEvent({ type: 'completed', session })).toEqual({
      type: 'completed',
      session,
    });
  });

  it('maps pending', () => {
    expect(
      decodeEvent({
        type: 'pending',
        sessionId: 's',
        productIds: ['a', 7, 'b'],
      })
    ).toEqual({ type: 'pending', sessionId: 's', productIds: ['a', 'b'] });
  });

  it.each(['awaitingBackend', 'rejected'])('maps %s', (type) => {
    expect(
      decodeEvent({ type, sessionId: 's', transactionId: '5', failure })
    ).toEqual({ type, sessionId: 's', transactionId: '5', failure });
    expect(decodeEvent({ type, sessionId: 's', failure })).toEqual({
      type,
      sessionId: 's',
      failure,
    });
  });

  it('maps hostedCheckoutOpened', () => {
    expect(decodeEvent({ type: 'hostedCheckoutOpened', session })).toEqual({
      type: 'hostedCheckoutOpened',
      session,
    });
  });

  it('maps unmatched purchases from both platforms', () => {
    expect(
      decodeEvent({
        type: 'unmatchedPurchase',
        transactionId: '1',
        productIds: ['p'],
      })
    ).toEqual({
      type: 'unmatchedPurchase',
      transactionId: '1',
      productIds: ['p'],
    });
    expect(
      decodeEvent({
        type: 'unmatchedPurchase',
        purchaseToken: 't',
        productIds: ['p'],
      })
    ).toEqual({
      type: 'unmatchedPurchase',
      purchaseToken: 't',
      productIds: ['p'],
    });
  });

  it('maps unverifiedTransaction', () => {
    expect(
      decodeEvent({
        type: 'unverifiedTransaction',
        transactionId: '1',
        reason: 'r',
      })
    ).toEqual({
      type: 'unverifiedTransaction',
      transactionId: '1',
      reason: 'r',
    });
  });

  it('maps unknown types and malformed payloads to unknown', () => {
    const raw = { type: 'refundIssued', sessionId: 's' };
    expect(decodeEvent(raw)).toEqual({
      type: 'unknown',
      name: 'refundIssued',
      raw,
    });
    expect(decodeEvent({ type: 'pending' })).toMatchObject({ type: 'unknown' });
    expect(decodeEvent(null)).toEqual({ type: 'unknown', name: '', raw: null });
  });

  it('decodes a list and tolerates a missing one', () => {
    expect(decodeEvents({ events: [{ type: 'x' }] })).toHaveLength(1);
    expect(decodeEvents({})).toEqual([]);
    expect(decodeEvents(null)).toEqual([]);
  });
});

describe('decodeReturnLinkResult', () => {
  it('maps every result', () => {
    expect(decodeReturnLinkResult({ type: 'ignored' })).toEqual({
      type: 'ignored',
    });
    for (const type of ['completed', 'notPaid', 'stillPending']) {
      expect(decodeReturnLinkResult({ type, session })).toEqual({
        type,
        session,
      });
    }
    expect(decodeReturnLinkResult({ type: 'backendFailed', failure })).toEqual({
      type: 'backendFailed',
      failure,
    });
  });

  it('maps a result it does not know to unknown', () => {
    const raw = { type: 'expiredLater' };
    expect(decodeReturnLinkResult(raw)).toEqual({
      type: 'unknown',
      name: 'expiredLater',
      raw,
    });
    expect(decodeReturnLinkResult({ type: 'completed' })).toMatchObject({
      type: 'unknown',
    });
  });
});

describe('entitlements and refunds', () => {
  it('accepts the entitlement shape and refuses another', () => {
    const owned = { customerRef: 'c', active: true, items: [] };
    expect(decodeEntitlements(owned)).toBe(owned);
    expect(() => decodeEntitlements(null)).toThrow(TypeError);
    expect(() => decodeEntitlements({ customerRef: 'c' })).toThrow(TypeError);
  });

  it('reads the refund outcome, including a value added later', () => {
    expect(decodeRefundOutcome({ outcome: 'submitted' })).toBe('submitted');
    expect(decodeRefundOutcome({ outcome: 'deferred' })).toBe('deferred');
    expect(() => decodeRefundOutcome(null)).toThrow(TypeError);
  });
});
