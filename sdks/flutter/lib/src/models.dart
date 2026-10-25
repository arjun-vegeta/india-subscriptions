import 'package:meta/meta.dart';

// The string-valued types below are open: a value that a newer server or native
// SDK adds is kept as it is instead of failing. Compare with the constants
// (`status == SessionStatus.completed`) and keep a default branch in a `switch`.

/// The platform a purchase was made on.
extension type const PurchasePlatform(String value) {
  static const ios = PurchasePlatform('ios');
  static const android = PurchasePlatform('android');
  static const web = PurchasePlatform('web');
}

/// The provider that holds a purchase: a store or a payment gateway.
extension type const PaymentProvider(String value) {
  static const appStore = PaymentProvider('app_store');
  static const googlePlay = PaymentProvider('google_play');
  static const razorpay = PaymentProvider('razorpay');
  static const cashfree = PaymentProvider('cashfree');
  static const payu = PaymentProvider('payu');
  static const phonepe = PaymentProvider('phonepe');
  static const paytm = PaymentProvider('paytm');
}

/// Where purchases on a platform may be taken.
extension type const ChannelPolicy(String value) {
  /// The platform's store only.
  static const store = ChannelPolicy('store');

  /// Google Play with its choice screen offering a payment gateway.
  static const userChoice = ChannelPolicy('user_choice');

  /// Payment gateways only.
  static const gateways = ChannelPolicy('gateways');
}

/// The channel a purchase went through.
extension type const SalesChannel(String value) {
  static const store = SalesChannel('store');
  static const gateway = SalesChannel('gateway');
}

/// What a product is.
extension type const ProductKind(String value) {
  static const subscription = ProductKind('subscription');
  static const oneTime = ProductKind('one_time');
}

/// Where a purchase session is in its life.
extension type const SessionStatus(String value) {
  /// Created; the customer has not come back from the checkout.
  static const open = SessionStatus('open');

  /// Paid or approved but not confirmed by the provider yet.
  static const awaitingPayment = SessionStatus('awaiting_payment');

  /// Paid or authorised and recorded as an entitlement.
  static const completed = SessionStatus('completed');

  /// A verification said the purchase was not paid.
  static const failed = SessionStatus('failed');

  /// The session passed its expiry without a payment.
  static const expired = SessionStatus('expired');
}

/// What a customer owns, per entitlement item.
extension type const EntitlementStatus(String value) {
  static const active = EntitlementStatus('active');
  static const trialing = EntitlementStatus('trialing');
  static const pastDue = EntitlementStatus('past_due');
  static const paused = EntitlementStatus('paused');
  static const halted = EntitlementStatus('halted');
  static const cancelled = EntitlementStatus('cancelled');
  static const expired = EntitlementStatus('expired');
  static const refunded = EntitlementStatus('refunded');
}

/// A customer: identity and contact details.
@immutable
class Customer {
  const Customer({this.id, this.name, this.email, this.phone, this.state});

  final String? id;
  final String? name;
  final String? email;

  /// Mobile number; 10 digits or E.164.
  final String? phone;

  /// The customer's state or union territory in India (for example
  /// "Karnataka"). Needed for Google Play user choice billing.
  final String? state;
}

/// One way the customer can pay for a session.
@immutable
class PurchaseOption {
  const PurchaseOption({
    required this.channel,
    required this.provider,
    required this.handle,
    required this.checkoutKind,
    this.storeProductId,
    this.hostedUrl,
  });

  final SalesChannel channel;
  final PaymentProvider provider;

  /// The id the provider returned when the purchase was created.
  final String handle;

  /// The kind of the server's checkout instruction (`apple_storekit`,
  /// `google_play_billing`, or a gateway kind).
  final String checkoutKind;

  /// The App Store Connect or Play Console product id, for a store option.
  final String? storeProductId;

  /// A page that performs a gateway option's checkout.
  final String? hostedUrl;
}

/// A purchase in progress or done: where the customer may pay and how it ended.
@immutable
class PurchaseSession {
  const PurchaseSession({
    required this.id,
    required this.platform,
    required this.product,
    required this.policy,
    required this.status,
    required this.customerRef,
    required this.options,
    required this.createdAt,
    required this.expiresAt,
    this.reference,
    this.returnUrl,
    this.completedAt,
    this.subscriptionId,
    this.paymentId,
    this.provider,
  });

  /// The session id. Whoever holds it can complete the session, so keep it out
  /// of logs.
  final String id;
  final PurchasePlatform platform;

  /// The key of the product.
  final String product;
  final ChannelPolicy policy;
  final SessionStatus status;
  final String customerRef;
  final List<PurchaseOption> options;
  final DateTime createdAt;

  /// When an unpaid session expires.
  final DateTime expiresAt;
  final String? reference;
  final String? returnUrl;
  final DateTime? completedAt;
  final String? subscriptionId;
  final String? paymentId;

  /// The provider the purchase was confirmed at.
  final PaymentProvider? provider;
}

/// One purchase the customer owns or owned.
@immutable
class EntitlementItem {
  const EntitlementItem({
    required this.product,
    required this.kind,
    required this.provider,
    required this.channel,
    required this.platform,
    required this.status,
    required this.active,
    required this.updatedAt,
    this.subscriptionId,
    this.paymentId,
    this.cancelAtPeriodEnd,
    this.currentPeriodEnd,
  });

  /// The key of the product.
  final String product;
  final ProductKind kind;
  final PaymentProvider provider;
  final SalesChannel channel;
  final PurchasePlatform platform;
  final EntitlementStatus status;

  /// True when the item gives access now.
  final bool active;
  final DateTime updatedAt;
  final String? subscriptionId;
  final String? paymentId;

  /// True when the subscription ends at the end of the current period.
  final bool? cancelAtPeriodEnd;

  /// End of the current paid period, where known.
  final DateTime? currentPeriodEnd;
}

/// What a customer owns, across app stores and gateways. The backend is the
/// source of truth for it.
@immutable
class Entitlements {
  const Entitlements({
    required this.customerRef,
    required this.active,
    required this.items,
  });

  final String customerRef;

  /// True when at least one item gives access now.
  final bool active;

  /// Every purchase of the customer, newest change first, including ended ones.
  final List<EntitlementItem> items;

  /// The items that give access now.
  List<EntitlementItem> get activeItems =>
      items.where((item) => item.active).toList(growable: false);

  /// Whether the customer has an active item for the product key.
  bool hasAccess(String product) =>
      items.any((item) => item.product == product && item.active);
}

/// The five relative paths of the merchant backend. A null path keeps the
/// native SDK's default (`v1/purchases`, `v1/purchases/{sessionId}`,
/// `v1/purchases/{sessionId}/alternative`, `v1/purchases/{sessionId}/complete`,
/// `v1/entitlements/{customerRef}`).
@immutable
class PurchasePaths {
  const PurchasePaths({
    this.start,
    this.session,
    this.alternative,
    this.complete,
    this.entitlements,
  });

  final String? start;
  final String? session;
  final String? alternative;
  final String? complete;
  final String? entitlements;
}
