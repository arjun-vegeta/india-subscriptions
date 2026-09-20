import { describe, expect, it } from 'vitest';
import { Provider } from '../../src/constants.js';
import { MAX_GATEWAY_ID_LENGTH, chargeIdFor, notificationIdFor, scheduleIdFor } from '../../src/scheduler/index.js';

const SAFE = /^[A-Za-z0-9_-]+$/;
const SCHEDULE = scheduleIdFor(Provider.PayU, 'order:with/odd chars #1');

describe('gateway-safe charge and notification ids', () => {
  it('stay within the gateway limit even at cycle 99,999 and attempt 999', () => {
    expect(chargeIdFor(SCHEDULE, 99_999, 999).length).toBeLessThanOrEqual(MAX_GATEWAY_ID_LENGTH);
    expect(notificationIdFor(SCHEDULE, 99_999, 999, 99).length).toBeLessThanOrEqual(MAX_GATEWAY_ID_LENGTH);
    expect(notificationIdFor(SCHEDULE, 99_999, 999, 1_295).length).toBeLessThanOrEqual(MAX_GATEWAY_ID_LENGTH);
    expect(MAX_GATEWAY_ID_LENGTH).toBe(25);
  });

  it('use only letters, digits, underscore and hyphen, whatever the schedule id contains', () => {
    for (const id of [SCHEDULE, 'a b', 'ünï', '', ':', 'x'.repeat(500)]) {
      expect(chargeIdFor(id, 12, 3)).toMatch(SAFE);
      expect(notificationIdFor(id, 12, 3, 2)).toMatch(SAFE);
    }
  });

  it('are deterministic', () => {
    expect(chargeIdFor(SCHEDULE, 7, 2)).toBe(chargeIdFor(SCHEDULE, 7, 2));
    expect(notificationIdFor(SCHEDULE, 7, 2, 1)).toBe(notificationIdFor(SCHEDULE, 7, 2, 1));
  });

  it('never collide across charge/notification, schedules, cycles, attempts and rounds', () => {
    const seen = new Set<string>();
    let count = 0;
    for (let schedule = 0; schedule < 200; schedule++) {
      const id = scheduleIdFor(Provider.PayU, `ref-${schedule}`);
      for (const cycle of [0, 1, 2, 35, 36, 99, 100, 101, 1295, 1296, 99_999]) {
        for (const attempt of [1, 2, 3, 35, 36, 999]) {
          seen.add(chargeIdFor(id, cycle, attempt));
          count += 1;
          for (const round of [1, 2, 36]) {
            seen.add(notificationIdFor(id, cycle, attempt, round));
            count += 1;
          }
        }
      }
    }
    expect(seen.size).toBe(count);
  });

  it('separate the same key on different providers', () => {
    expect(chargeIdFor(scheduleIdFor(Provider.PayU, 'ref'), 0, 1)).not.toBe(chargeIdFor(scheduleIdFor(Provider.Cashfree, 'ref'), 0, 1));
  });

  it('are compact at the first cycle', () => {
    expect(chargeIdFor(SCHEDULE, 0, 1).length).toBeLessThanOrEqual(18);
  });
});
