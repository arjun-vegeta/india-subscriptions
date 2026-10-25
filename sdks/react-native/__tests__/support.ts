import { Platform } from 'react-native';

export const session = {
  id: 'ses_1',
  platform: 'ios',
  product: 'pro_monthly',
  policy: 'store',
  status: 'completed',
  customerRef: 'cust_1',
  options: [],
  attempts: [],
  createdAt: '2026-11-24T10:00:00.000Z',
  expiresAt: '2026-11-24T10:30:00.000Z',
};

export const failure = {
  reason: 'backendUnreachable',
  code: 'TIMEOUT',
  message: 'timed out',
};

export function setPlatform(os: 'ios' | 'android'): void {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
}
