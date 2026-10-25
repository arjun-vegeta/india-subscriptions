import 'dart:async';

import 'package:india_subscriptions/india_subscriptions.dart';
import 'package:material_ui/material_ui.dart';

/// The root of your backend, which forwards the service's five purchase calls.
/// Pass your own with `--dart-define=BILLING_URL=https://api.example.com/billing/`.
const _billingUrl = String.fromEnvironment(
  'BILLING_URL',
  defaultValue: 'https://api.example.com/billing/',
);

/// The product key of your catalogue.
const _productKey = String.fromEnvironment(
  'PRODUCT_KEY',
  defaultValue: 'pro_monthly',
);

void main() {
  runApp(const ExampleApp());
}

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key});

  @override
  Widget build(BuildContext context) =>
      const MaterialApp(title: 'India Subscriptions', home: PurchasePage());
}

class PurchasePage extends StatefulWidget {
  const PurchasePage({super.key});

  @override
  State<PurchasePage> createState() => _PurchasePageState();
}

class _PurchasePageState extends State<PurchasePage> {
  final _subs = IndiaSubscriptions.instance;
  final _log = <String>[];
  StreamSubscription<PurchaseEvent>? _events;
  StreamSubscription<ReturnLinkResult>? _links;
  String _status = 'Starting…';

  // Your own id for the signed-in customer. The backend decides which customer
  // the user may buy for.
  static const _customerRef = 'cust_demo';

  @override
  void initState() {
    super.initState();
    // Listen first: the native SDKs do not replay events.
    _events = _subs.events.listen(_onEvent);
    _links = _subs.returnLinkResults.listen(_onReturnLink);
    unawaited(_start());
  }

  Future<void> _start() async {
    try {
      await _subs.configure(
        baseUrl: _billingUrl,
        // The signed-in user's own token, never the service's API key. Call
        // setAuthorization again when the token changes.
        authorization: 'Bearer demo-user-token',
      );
      _set('Ready. Entitlements are read from the backend.');
    } on IndiaSubscriptionsException catch (error) {
      _set('Could not start: $error');
    }
  }

  @override
  void dispose() {
    unawaited(_events?.cancel());
    unawaited(_links?.cancel());
    super.dispose();
  }

  void _set(String status) {
    if (!mounted) return;
    setState(() => _status = status);
  }

  void _onEvent(PurchaseEvent event) {
    final text = switch (event) {
      PurchaseCompletedEvent(:final session) =>
        'Purchase of ${session.product} confirmed.',
      PurchasePendingEvent() => 'Waiting for approval.',
      PurchaseAwaitingBackendEvent() => 'Confirming your purchase…',
      PurchaseRejectedEvent() =>
        'We could not confirm a purchase. Please contact support.',
      HostedCheckoutOpenedEvent() => 'Checkout opened.',
      UnmatchedPurchaseEvent() => 'A purchase this device has no record of.',
      UnverifiedTransactionEvent() => 'A transaction could not be verified.',
      UnknownPurchaseEvent(:final kind) => 'Event: $kind',
    };
    if (!mounted) return;
    setState(() => _log.insert(0, text));
  }

  void _onReturnLink(ReturnLinkResult result) {
    _set(switch (result) {
      ReturnLinkCompleted() => 'Welcome to Pro.',
      ReturnLinkNotPaid() => 'The payment did not go through.',
      ReturnLinkStillPending() => 'Confirming your payment…',
      ReturnLinkBackendFailed() => 'Could not check the payment.',
      ReturnLinkIgnored() => _status,
      UnknownReturnLinkResult(:final kind) => 'Return link: $kind',
    });
  }

  Future<void> _buy() async {
    try {
      final outcome = await _subs.purchase(
        _productKey,
        customerRef: _customerRef,
        customer: const Customer(
          name: 'Asha',
          email: 'asha@example.com',
          state: 'Karnataka',
        ),
        // Android: the app link declared in AndroidManifest.xml.
        returnUrl: 'myapp://billing/return',
      );
      _set(switch (outcome) {
        PurchaseCompleted() => 'Welcome to Pro.',
        PurchasePending() => 'Waiting for approval.',
        PurchaseCancelled() => '',
        PurchaseUnverified() => 'The store could not verify this purchase.',
        PurchaseAwaitingBackend() => 'Confirming your purchase…',
        PurchaseRejected() =>
          'We could not confirm this purchase. Please contact support.',
        PurchaseAwaitingReturn() => 'Finish the payment in the browser.',
        PurchaseFailed(:final failure) => 'Google Play: ${failure.reason.name}',
        UnknownPurchaseOutcome(:final kind) => 'Outcome: $kind',
      });
    } on IndiaSubscriptionsException catch (error) {
      _set('Could not start the purchase: $error');
    }
  }

  Future<void> _restore() async {
    try {
      final entitlements = await _subs.restorePurchases(_customerRef);
      _set(
        entitlements.hasAccess(_productKey)
            ? 'Pro restored.'
            : 'No active purchase found.',
      );
    } on IndiaSubscriptionsException catch (error) {
      _set('Restore failed: $error');
    }
  }

  Future<void> _manage() async {
    try {
      // iOS shows Apple's sheet; Android opens Google Play's page. A call
      // that does not apply to the platform throws.
      await _subs.showManageSubscriptions();
    } on UnsupportedOnPlatformException {
      try {
        await _subs.openSubscriptionManagement();
      } on IndiaSubscriptionsException catch (error) {
        _set('$error');
      }
    } on IndiaSubscriptionsException catch (error) {
      _set('$error');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('India Subscriptions')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(_status, key: const Key('status')),
            const SizedBox(height: 16),
            FilledButton(onPressed: _buy, child: const Text('Subscribe')),
            OutlinedButton(
              onPressed: _restore,
              child: const Text('Restore purchases'),
            ),
            OutlinedButton(
              onPressed: _manage,
              child: const Text('Manage subscription'),
            ),
            const SizedBox(height: 16),
            Expanded(
              child: ListView(children: [for (final line in _log) Text(line)]),
            ),
          ],
        ),
      ),
    );
  }
}
