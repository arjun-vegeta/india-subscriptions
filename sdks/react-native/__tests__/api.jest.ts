import { Platform } from 'react-native';
import * as Subscriptions from '../src';
import { failure, session, setPlatform } from './support';

type Listener = (payload: unknown) => void;

const mockListeners: Listener[] = [];
const mockRemoved = jest.fn();

jest.mock('../src/NativeIndiaSubscriptionsReactNative', () => ({
  __esModule: true,
  default: {
    configure: jest.fn(),
    setAuthorization: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    purchase: jest.fn(),
    processPending: jest.fn(),
    retryRejected: jest.fn(),
    restorePurchases: jest.fn(),
    entitlements: jest.fn(),
    showManageSubscriptions: jest.fn(),
    requestRefund: jest.fn(),
    subscriptionManagementUrl: jest.fn(),
    handleReturnLink: jest.fn(),
    onPurchaseEvent: jest.fn((listener: Listener) => {
      mockListeners.push(listener);
      return { remove: mockRemoved };
    }),
  },
}));

type NativeMethod =
  | 'configure'
  | 'setAuthorization'
  | 'start'
  | 'stop'
  | 'purchase'
  | 'processPending'
  | 'retryRejected'
  | 'restorePurchases'
  | 'entitlements'
  | 'showManageSubscriptions'
  | 'requestRefund'
  | 'subscriptionManagementUrl'
  | 'handleReturnLink'
  | 'onPurchaseEvent';

const mockNative: Record<NativeMethod, jest.Mock> = jest.requireMock(
  '../src/NativeIndiaSubscriptionsReactNative'
).default;

beforeEach(() => {
  jest.clearAllMocks();
  mockListeners.length = 0;
  setPlatform('ios');
  for (const fn of Object.values(mockNative)) {
    if (jest.isMockFunction(fn) && fn !== mockNative.onPurchaseEvent) {
      fn.mockResolvedValue(undefined);
    }
  }
});

describe('argument translation', () => {
  it('sends configure options without undefined or null members', async () => {
    await Subscriptions.configure({
      baseUrl: 'https://api.example.com/billing/',
      authorization: undefined,
      headers: { 'X-App': 'demo' },
      paths: { start: 'purchases', session: undefined },
      ios: { finishUnmatchedTransactions: true },
    });
    expect(mockNative.configure).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.com/billing/',
      headers: { 'X-App': 'demo' },
      paths: { start: 'purchases' },
      ios: { finishUnmatchedTransactions: true },
    });
  });

  it('sends the same configure options on Android, headers included', async () => {
    setPlatform('android');
    await Subscriptions.configure({
      baseUrl: 'https://api.example.com/',
      headers: { 'X-App-Version': '42' },
      android: { allowBasePlanFallback: true },
    });
    expect(mockNative.configure).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.com/',
      headers: { 'X-App-Version': '42' },
      android: { allowBasePlanFallback: true },
    });
  });

  it('passes the authorization value through, including null', async () => {
    await Subscriptions.setAuthorization('Bearer abc');
    await Subscriptions.setAuthorization(null);
    expect(mockNative.setAuthorization).toHaveBeenNthCalledWith(
      1,
      'Bearer abc'
    );
    expect(mockNative.setAuthorization).toHaveBeenNthCalledWith(2, null);
  });

  it('sends the product key and only the options that were set', async () => {
    mockNative.purchase.mockResolvedValue({ type: 'cancelled' });
    await Subscriptions.purchase('pro_monthly', {
      customerRef: 'cust_1',
      customer: { name: 'Asha', state: 'Karnataka', email: undefined },
      reference: undefined,
      returnUrl: 'myapp://billing/return',
    });
    expect(mockNative.purchase).toHaveBeenCalledWith('pro_monthly', {
      customerRef: 'cust_1',
      customer: { name: 'Asha', state: 'Karnataka' },
      returnUrl: 'myapp://billing/return',
    });
  });

  it('passes the customer reference to restore and entitlements', async () => {
    const owned = { customerRef: 'cust_1', active: false, items: [] };
    mockNative.restorePurchases.mockResolvedValue(owned);
    mockNative.entitlements.mockResolvedValue(owned);
    expect(await Subscriptions.restorePurchases('cust_1')).toEqual(owned);
    expect(await Subscriptions.entitlements('cust_1')).toEqual(owned);
    expect(mockNative.restorePurchases).toHaveBeenCalledWith('cust_1');
    expect(mockNative.entitlements).toHaveBeenCalledWith('cust_1');
  });

  it('forwards start and stop', async () => {
    await Subscriptions.start();
    await Subscriptions.stop();
    expect(mockNative.start).toHaveBeenCalledTimes(1);
    expect(mockNative.stop).toHaveBeenCalledTimes(1);
  });

  it('rejects entitlements the native side returned unreadable', async () => {
    mockNative.entitlements.mockResolvedValue({ nope: true });
    await expect(Subscriptions.entitlements('cust_1')).rejects.toMatchObject({
      name: 'IndiaSubscriptionsError',
      code: 'UNKNOWN',
    });
  });
});

describe('pending purchases', () => {
  it('decodes the events of a pass', async () => {
    mockNative.processPending.mockResolvedValue({
      events: [
        { type: 'completed', session, transactionId: '2000001' },
        { type: 'somethingNew' },
      ],
    });
    const events = await Subscriptions.processPendingPurchases();
    expect(events).toEqual([
      { type: 'completed', session, transactionId: '2000001' },
      { type: 'unknown', name: 'somethingNew', raw: { type: 'somethingNew' } },
    ]);
  });

  it('decodes the events of a retry of rejected purchases', async () => {
    mockNative.retryRejected.mockResolvedValue({ events: [] });
    expect(await Subscriptions.retryRejectedPurchases()).toEqual([]);
  });
});

describe('the event subscription', () => {
  it('delivers decoded events and removes the native subscription', () => {
    const received: unknown[] = [];
    const subscription = Subscriptions.addPurchaseListener((event) =>
      received.push(event)
    );
    mockListeners[0]?.({ type: 'rejected', sessionId: 'ses_1', failure });
    mockListeners[0]?.({ type: 'brandNew', value: 1 });
    expect(received).toEqual([
      { type: 'rejected', sessionId: 'ses_1', failure },
      {
        type: 'unknown',
        name: 'brandNew',
        raw: { type: 'brandNew', value: 1 },
      },
    ]);
    subscription.remove();
    expect(mockRemoved).toHaveBeenCalledTimes(1);
  });
});

describe('errors', () => {
  it('turns a native rejection into an IndiaSubscriptionsError with its details', async () => {
    mockNative.purchase.mockRejectedValue({
      code: 'BACKEND',
      message: 'VALIDATION: bad product',
      userInfo: { kind: 'server', serverCode: 'VALIDATION', statusCode: 422 },
    });
    const error = await Subscriptions.purchase('nope', {
      customerRef: 'c',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Subscriptions.IndiaSubscriptionsError);
    expect(error).toMatchObject({
      code: Subscriptions.ErrorCode.Backend,
      message: 'VALIDATION: bad product',
      details: { kind: 'server', serverCode: 'VALIDATION', statusCode: 422 },
    });
  });

  it('keeps an unfamiliar code and survives a rejection that is not an object', async () => {
    mockNative.start.mockRejectedValueOnce({
      code: 'FROM_THE_FUTURE',
      message: 'x',
    });
    await expect(Subscriptions.start()).rejects.toMatchObject({
      code: 'FROM_THE_FUTURE',
    });
    mockNative.stop.mockRejectedValueOnce('plain string');
    await expect(Subscriptions.stop()).rejects.toMatchObject({
      code: 'UNKNOWN',
      message: 'plain string',
    });
  });
});

describe('calls that belong to one platform', () => {
  it('rejects the Android calls on iOS with NOT_APPLICABLE, without calling native', async () => {
    expect(Platform.OS).toBe('ios');
    await expect(
      Subscriptions.handleReturnLink('myapp://r')
    ).rejects.toMatchObject({
      code: 'NOT_APPLICABLE',
      details: { appliesTo: 'android' },
    });
    await expect(
      Subscriptions.getSubscriptionManagementUrl('pro')
    ).rejects.toMatchObject({ code: 'NOT_APPLICABLE' });
    expect(mockNative.handleReturnLink).not.toHaveBeenCalled();
    expect(mockNative.subscriptionManagementUrl).not.toHaveBeenCalled();
  });

  it('rejects the iOS calls on Android with NOT_APPLICABLE, without calling native', async () => {
    setPlatform('android');
    await expect(Subscriptions.showManageSubscriptions()).rejects.toMatchObject(
      {
        code: 'NOT_APPLICABLE',
        details: { appliesTo: 'ios' },
      }
    );
    await expect(Subscriptions.requestRefund('2000001')).rejects.toMatchObject({
      code: 'NOT_APPLICABLE',
    });
    expect(mockNative.showManageSubscriptions).not.toHaveBeenCalled();
    expect(mockNative.requestRefund).not.toHaveBeenCalled();
  });

  it('runs the iOS calls on iOS', async () => {
    mockNative.requestRefund.mockResolvedValue({ outcome: 'submitted' });
    await Subscriptions.showManageSubscriptions();
    expect(mockNative.showManageSubscriptions).toHaveBeenCalledTimes(1);
    expect(await Subscriptions.requestRefund('2000001')).toBe('submitted');
    expect(mockNative.requestRefund).toHaveBeenCalledWith('2000001');
  });

  it('rejects a refund result it cannot read instead of inventing one', async () => {
    mockNative.requestRefund.mockResolvedValue({});
    await expect(Subscriptions.requestRefund('1')).rejects.toMatchObject({
      code: 'UNKNOWN',
    });
  });

  it('runs the Android calls on Android', async () => {
    setPlatform('android');
    mockNative.subscriptionManagementUrl.mockResolvedValue(
      'https://play.google.com/store/account/subscriptions'
    );
    mockNative.handleReturnLink.mockResolvedValue({ type: 'ignored' });
    expect(await Subscriptions.getSubscriptionManagementUrl()).toBe(
      'https://play.google.com/store/account/subscriptions'
    );
    expect(mockNative.subscriptionManagementUrl).toHaveBeenCalledWith(null);
    await Subscriptions.getSubscriptionManagementUrl('pro_monthly');
    expect(mockNative.subscriptionManagementUrl).toHaveBeenLastCalledWith(
      'pro_monthly'
    );
    expect(
      await Subscriptions.handleReturnLink('myapp://r?session=ses_1')
    ).toEqual({
      type: 'ignored',
    });
    expect(mockNative.handleReturnLink).toHaveBeenCalledWith(
      'myapp://r?session=ses_1'
    );
  });
});
