import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:india_subscriptions_example/main.dart';

const _prefix = 'dev.flutter.pigeon.india_subscriptions';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    // The native side is absent in a widget test: answer `configure` and
    // accept the two event listeners.
    messenger.setMockMessageHandler(
      '$_prefix.PurchasesHostApi.configure',
      (message) async =>
          const StandardMessageCodec().encodeMessage(<Object?>[null]),
    );
    for (final name in ['purchaseEvents', 'returnLinkResults']) {
      messenger.setMockStreamHandler(
        EventChannel('$_prefix.PurchaseStreams.$name'),
        MockStreamHandler.inline(onListen: (arguments, events) {}),
      );
    }
  });

  testWidgets('shows the purchase buttons', (tester) async {
    await tester.pumpWidget(const ExampleApp());
    expect(find.text('Subscribe'), findsOneWidget);
    expect(find.text('Restore purchases'), findsOneWidget);
    expect(find.text('Manage subscription'), findsOneWidget);
  });
}
