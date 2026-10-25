import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:india_subscriptions/india_subscriptions.dart';
import 'package:india_subscriptions/src/messages.g.dart' as wire;

import 'support.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeHost host;
  late IndiaSubscriptions subs;

  setUp(() {
    host = FakeHost();
    subs = IndiaSubscriptions(hostApi: host);
  });

  group('calls', () {
    test('configure sends the translated request', () async {
      await subs.configure(
        baseUrl: 'https://api.example.com/',
        authorization: 'Bearer a',
      );
      expect(host.configured?.baseUrl, 'https://api.example.com/');
      expect(host.configured?.authorization, 'Bearer a');
      expect(host.configured?.start, isTrue);
    });

    test('setAuthorization passes the new value, null clears it', () async {
      await subs.setAuthorization('Bearer b');
      expect(host.authorization, 'Bearer b');
      await subs.setAuthorization(null);
      expect(host.authorization, isNull);
      expect(host.calls, ['setAuthorization', 'setAuthorization']);
    });

    test('purchase translates arguments and maps the outcome', () async {
      host.outcome = wire.PurchaseOutcomeMessage(
        kind: 'completed',
        session: sessionMessage(),
      );
      final outcome = await subs.purchase(
        'pro_monthly',
        customerRef: 'cust_1',
        customer: const Customer(name: 'Asha', state: 'Karnataka'),
        reference: 'order-1',
        returnUrl: 'myapp://billing/return',
      );
      expect(outcome, isA<PurchaseCompleted>());
      expect(host.purchased?.product, 'pro_monthly');
      expect(host.purchased?.customerRef, 'cust_1');
      expect(host.purchased?.customer.state, 'Karnataka');
      expect(host.purchased?.reference, 'order-1');
      expect(host.purchased?.returnUrl, 'myapp://billing/return');
    });

    test('entitlements and restore map the answer', () async {
      host.entitlementsAnswer = wire.EntitlementsMessage(
        customerRef: 'cust_1',
        active: false,
        items: [],
      );
      expect((await subs.entitlements('cust_1')).active, isFalse);
      expect((await subs.restorePurchases('cust_1')).customerRef, 'cust_1');
      expect(host.calls, ['entitlements:cust_1', 'restorePurchases:cust_1']);
    });

    test(
      'processPending and retryRejected map the events they return',
      () async {
        host.eventsAnswer = [
          wire.PurchaseEventMessage(
            kind: 'completed',
            session: sessionMessage(),
          ),
          wire.PurchaseEventMessage(kind: 'somethingNew'),
        ];
        final processed = await subs.processPendingPurchases();
        expect(processed[0], isA<PurchaseCompletedEvent>());
        expect(processed[1], isA<UnknownPurchaseEvent>());
        expect(await subs.retryRejectedPurchases(), hasLength(2));
      },
    );

    test('dispose reaches the host', () async {
      await subs.dispose();
      expect(host.calls, ['dispose']);
    });
  });

  group('platform-only calls', () {
    test('iOS calls map and pass their arguments', () async {
      await subs.showManageSubscriptions();
      host.refundAnswer = 'cancelled';
      expect(await subs.requestRefund('2000'), RefundRequestOutcome.cancelled);
      expect(host.calls, ['showManageSubscriptions', 'requestRefund:2000']);
    });

    test('Android calls map and pass their arguments', () async {
      expect(
        await subs.subscriptionManagementUrl(productId: 'in.example.pro'),
        'https://play.google.com/x',
      );
      await subs.openSubscriptionManagement();
      host.linkAnswer = wire.ReturnLinkResultMessage(
        kind: 'completed',
        session: sessionMessage(platform: 'android'),
      );
      expect(
        await subs.handleReturnLink('myapp://billing/return?session=s'),
        isA<ReturnLinkCompleted>(),
      );
      expect(host.calls, [
        'subscriptionManagementUrl:in.example.pro',
        'openSubscriptionManagement:null',
        'handleReturnLink:myapp://billing/return?session=s',
      ]);
    });

    test('a platform that does not apply says so plainly', () async {
      host.error = PlatformException(
        code: 'unsupported_on_platform',
        message: 'showManageSubscriptions applies to iOS only.',
        details: {'method': 'showManageSubscriptions', 'platform': 'android'},
      );
      await expectLater(
        subs.showManageSubscriptions(),
        throwsA(
          isA<UnsupportedOnPlatformException>()
              .having((e) => e.method, 'method', 'showManageSubscriptions')
              .having((e) => e.platform, 'platform', 'android')
              .having((e) => e.message, 'message', contains('iOS only')),
        ),
      );
    });
  });

  group('errors', () {
    Future<Object> thrown(PlatformException error) async {
      host.error = error;
      try {
        await subs.purchase('p', customerRef: 'c');
      } on Object catch (caught) {
        return caught;
      }
      fail('nothing was thrown');
    }

    test('not configured', () async {
      final error = await thrown(
        PlatformException(code: 'not_configured', message: 'Call configure.'),
      );
      expect(error, isA<NotConfiguredException>());
    });

    test('backend failures keep the server code and status', () async {
      final error = await thrown(
        PlatformException(
          code: 'backend',
          message: 'CONFLICT: already subscribed',
          details: {
            'kind': 'server',
            'statusCode': 409,
            'serverCode': 'CONFLICT',
            'provider': 'app_store',
            'retryable': false,
          },
        ),
      );
      expect(error, isA<BackendException>());
      final backend = error as BackendException;
      expect(backend.kind, BackendFailureKind.server);
      expect(backend.statusCode, 409);
      expect(backend.serverCode, 'CONFLICT');
      expect(backend.retryable, isFalse);
    });

    test('a transport failure and an unknown kind', () async {
      final transport = await thrown(
        PlatformException(
          code: 'backend',
          message: 'offline',
          details: {'kind': 'transport'},
        ),
      );
      expect(
        (transport as BackendException).kind,
        BackendFailureKind.transport,
      );
      final unknown = await thrown(
        PlatformException(
          code: 'backend',
          message: 'x',
          details: {'kind': 'quic'},
        ),
      );
      expect((unknown as BackendException).kind, BackendFailureKind.unknown);
    });

    test('purchase start failures map every kind, unknown ones too', () async {
      for (final kind in PurchaseErrorKind.values) {
        if (kind == PurchaseErrorKind.unknown) continue;
        final error = await thrown(
          PlatformException(
            code: 'purchase',
            message: 'm',
            details: {'kind': kind.name},
          ),
        );
        expect((error as PurchaseStartException).kind, kind);
      }
      final unknown = await thrown(
        PlatformException(
          code: 'purchase',
          message: 'm',
          details: {'kind': 'brandNew'},
        ),
      );
      expect(
        (unknown as PurchaseStartException).kind,
        PurchaseErrorKind.unknown,
      );
      expect(unknown.rawKind, 'brandNew');
    });

    test('any other code becomes a PlatformFailureException', () async {
      final error = await thrown(PlatformException(code: 'boom', message: 'x'));
      expect((error as PlatformFailureException).code, 'boom');
    });
  });

  group('streams', () {
    test(
      'events are mapped and unknown kinds do not break the stream',
      () async {
        final source = StreamController<wire.PurchaseEventMessage>.broadcast();
        final withStream = IndiaSubscriptions(
          hostApi: host,
          purchaseEvents: () => source.stream,
        );
        final received = <PurchaseEvent>[];
        final subscription = withStream.events.listen(received.add);
        source
          ..add(
            wire.PurchaseEventMessage(
              kind: 'completed',
              session: sessionMessage(),
              transactionId: '1',
            ),
          )
          ..add(wire.PurchaseEventMessage(kind: 'fromTheFuture'))
          ..add(
            wire.PurchaseEventMessage(
              kind: 'pending',
              sessionId: 's',
              productIds: ['p'],
            ),
          );
        await Future<void>.delayed(Duration.zero);
        expect(received, [
          isA<PurchaseCompletedEvent>(),
          isA<UnknownPurchaseEvent>(),
          isA<PurchasePendingEvent>(),
        ]);
        await subscription.cancel();
        await source.close();
      },
    );

    test('return link results are mapped', () async {
      final source = StreamController<wire.ReturnLinkResultMessage>.broadcast();
      final withStream = IndiaSubscriptions(
        hostApi: host,
        returnLinkResults: () => source.stream,
      );
      final results = <ReturnLinkResult>[];
      final subscription = withStream.returnLinkResults.listen(results.add);
      source.add(
        wire.ReturnLinkResultMessage(
          kind: 'completed',
          session: sessionMessage(platform: 'android'),
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(results.single, isA<ReturnLinkCompleted>());
      await subscription.cancel();
      await source.close();
    });
  });

  group('over the channel', () {
    // The generated channels, with a decoded handler in place of the native side.
    const prefix = 'dev.flutter.pigeon.india_subscriptions';
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

    tearDown(() {
      messenger.setMockDecodedMessageHandler<Object?>(
        BasicMessageChannel<Object?>(
          '$prefix.PurchasesHostApi.showManageSubscriptions',
          wire.PurchasesHostApi.pigeonChannelCodec,
        ),
        null,
      );
    });

    test('an error reply from the native side reaches Dart typed', () async {
      messenger.setMockDecodedMessageHandler<Object?>(
        BasicMessageChannel<Object?>(
          '$prefix.PurchasesHostApi.showManageSubscriptions',
          wire.PurchasesHostApi.pigeonChannelCodec,
        ),
        (Object? message) async => <Object?>[
          'unsupported_on_platform',
          'showManageSubscriptions applies to iOS only.',
          <String, Object?>{
            'method': 'showManageSubscriptions',
            'platform': 'android',
          },
        ],
      );
      await expectLater(
        IndiaSubscriptions().showManageSubscriptions(),
        throwsA(isA<UnsupportedOnPlatformException>()),
      );
    });

    test('the event channel delivers generated messages to events', () async {
      const channel = EventChannel(
        '$prefix.PurchaseStreams.purchaseEvents',
        wire.pigeonMethodCodec,
      );
      messenger.setMockStreamHandler(
        channel,
        MockStreamHandler.inline(
          onListen: (arguments, events) {
            events.success(
              wire.PurchaseEventMessage(
                kind: 'unmatchedPurchase',
                purchaseToken: 'tok',
                productIds: ['p'],
              ),
            );
          },
        ),
      );
      final event = await IndiaSubscriptions().events.first;
      expect(event, isA<UnmatchedPurchaseEvent>());
      expect((event as UnmatchedPurchaseEvent).purchaseToken, 'tok');
      messenger.setMockStreamHandler(channel, null);
    });
  });
}
