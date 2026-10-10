import { describe, expect, it } from 'vitest';
import { Provider } from '../../src/constants.js';
import {
  CircuitState,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_FAILURE_THRESHOLD,
  RouteExclusion,
  RouteOutcomeKind,
  RouteOutcomeResult,
  type Router,
} from '../../src/routing/index.js';
import { MINUTE, caps, makeRouter, SUBSCRIPTION } from './helpers.js';

const { Razorpay, Cashfree } = Provider;
const { Success, Failure, Unavailable } = RouteOutcomeResult;
const COOLDOWN = MINUTE;

function harness(failureThreshold = 3) {
  return makeRouter({
    capabilities: [caps(Razorpay), caps(Cashfree)],
    strategy: { circuitBreaker: { failureThreshold, cooldownMs: COOLDOWN } },
  });
}

const report = (router: Router, provider: Provider, result: RouteOutcomeResult, kind: RouteOutcomeKind = RouteOutcomeKind.Request) =>
  router.record({ provider, kind, result });

async function down(router: Router, provider: Provider, times: number) {
  for (let i = 0; i < times; i += 1) await report(router, provider, Unavailable);
}

describe('circuit breaker', () => {
  it('stays closed below the failure threshold', async () => {
    const { router } = harness();
    await down(router, Razorpay, 2);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.Closed);
    expect((await router.route(SUBSCRIPTION)).ranked).toContain(Razorpay);
  });

  it('opens at the threshold and excludes the gateway as unhealthy', async () => {
    const { router } = harness();
    await down(router, Razorpay, 3);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.Open);
    const decision = await router.route(SUBSCRIPTION);
    expect(decision.ranked).toEqual([Cashfree]);
    expect(decision.candidates.find((c) => c.provider === Razorpay)).toMatchObject({
      eligible: false,
      exclusions: [RouteExclusion.Unhealthy],
    });
    expect(router.circuitState(Cashfree)).toBe(CircuitState.Closed);
  });

  it('counts consecutive results: a success in between resets the count', async () => {
    const { router } = harness();
    await down(router, Razorpay, 2);
    await report(router, Razorpay, Success);
    await down(router, Razorpay, 2);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.Closed);
    await down(router, Razorpay, 1);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.Open);
  });

  it('is not moved by a failure, which says nothing about the gateway being up', async () => {
    const { router } = harness();
    await down(router, Razorpay, 2);
    await report(router, Razorpay, Failure);
    await down(router, Razorpay, 1);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.Open);
    await report(router, Razorpay, Failure);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.Open);
  });

  it('counts unavailable results of every outcome kind', async () => {
    const { router } = harness();
    await report(router, Razorpay, Unavailable, RouteOutcomeKind.Authorization);
    await report(router, Razorpay, Unavailable, RouteOutcomeKind.Charge);
    await report(router, Razorpay, Unavailable, RouteOutcomeKind.Payment);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.Open);
  });

  it('stays open until the cooldown has passed, then half-opens', async () => {
    const { router, clock } = harness();
    await down(router, Razorpay, 3);
    clock.advance(COOLDOWN - 1);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.Open);
    expect((await router.route(SUBSCRIPTION)).ranked).toEqual([Cashfree]);

    clock.advance(1);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.HalfOpen);
    const decision = await router.route(SUBSCRIPTION);
    expect(decision.ranked).toContain(Razorpay);
    expect(decision.candidates.find((c) => c.provider === Razorpay)?.factors?.healthy).toBe(false);
    expect(decision.candidates.find((c) => c.provider === Cashfree)?.factors?.healthy).toBe(true);
  });

  it('reopens for a fresh cooldown when a half-open gateway is unavailable again', async () => {
    const { router, clock } = harness();
    await down(router, Razorpay, 3);
    clock.advance(COOLDOWN);
    await down(router, Razorpay, 1);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.Open);
    expect((await router.route(SUBSCRIPTION)).ranked).toEqual([Cashfree]);

    clock.advance(COOLDOWN - 1);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.Open);
    clock.advance(1);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.HalfOpen);
  });

  it('closes when a half-open gateway succeeds, and then needs the full threshold to open again', async () => {
    const { router, clock } = harness();
    await down(router, Razorpay, 3);
    clock.advance(COOLDOWN);
    await report(router, Razorpay, Success);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.Closed);
    expect((await router.route(SUBSCRIPTION)).candidates.find((c) => c.provider === Razorpay)?.factors?.healthy).toBe(true);

    await down(router, Razorpay, 2);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.Closed);
    await down(router, Razorpay, 1);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.Open);
  });

  it('stays half-open after a failure: the gateway answered but has not proven itself', async () => {
    const { router, clock } = harness();
    await down(router, Razorpay, 3);
    clock.advance(COOLDOWN);
    await report(router, Razorpay, Failure);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.HalfOpen);
  });

  it('does not extend the cooldown when an unavailable result arrives while open', async () => {
    const { router, clock } = harness();
    await down(router, Razorpay, 3);
    clock.advance(COOLDOWN - 10);
    await down(router, Razorpay, 5);
    clock.advance(10);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.HalfOpen);
  });

  it('closes when a late success arrives while open', async () => {
    const { router } = harness();
    await down(router, Razorpay, 3);
    await report(router, Razorpay, Success);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.Closed);
  });

  it('keeps a separate circuit per gateway', async () => {
    const { router } = harness();
    await down(router, Razorpay, 2);
    await down(router, Cashfree, 2);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.Closed);
    expect(router.circuitState(Cashfree)).toBe(CircuitState.Closed);
    await down(router, Razorpay, 1);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.Open);
    expect(router.circuitState(Cashfree)).toBe(CircuitState.Closed);
  });

  it('defaults to five consecutive failures and a one minute cooldown', async () => {
    expect(DEFAULT_FAILURE_THRESHOLD).toBe(5);
    expect(DEFAULT_COOLDOWN_MS).toBe(60_000);
    const { router, clock } = makeRouter({ capabilities: [caps(Razorpay)] });
    await down(router, Razorpay, 4);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.Closed);
    await down(router, Razorpay, 1);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.Open);
    clock.advance(59_999);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.Open);
    clock.advance(1);
    expect(router.circuitState(Razorpay)).toBe(CircuitState.HalfOpen);
  });

  it('tracks providers that are not currently configured without error', async () => {
    const { router } = harness();
    await down(router, Provider.Paytm, 3);
    expect(router.circuitState(Provider.Paytm)).toBe(CircuitState.Open);
    expect((await router.route(SUBSCRIPTION)).ranked).toHaveLength(2);
  });
});
