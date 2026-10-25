import 'package:flutter/services.dart';
import 'package:meta/meta.dart';

/// What went wrong around a call to the native SDK. Nothing was charged when one
/// of these is thrown by `purchase`.
@immutable
sealed class IndiaSubscriptionsException implements Exception {
  const IndiaSubscriptionsException(this.message);
  final String message;

  @override
  String toString() => '$runtimeType: $message';
}

/// `configure` has not been called (or `dispose` was).
final class NotConfiguredException extends IndiaSubscriptionsException {
  const NotConfiguredException(super.message);
}

/// The call exists on both platforms but applies to one of them.
final class UnsupportedOnPlatformException extends IndiaSubscriptionsException {
  const UnsupportedOnPlatformException(
    super.message, {
    required this.method,
    required this.platform,
  });

  /// The Dart method that was called.
  final String method;

  /// The platform that reported it (`ios` or `android`).
  final String platform;
}

/// How a call to the backend failed.
enum BackendFailureKind {
  /// The backend answered with an error ([BackendException.serverCode] says
  /// which).
  server,

  /// The request got no answer (no network, a timeout).
  transport,

  /// The backend answered 2xx with a body the SDK cannot read.
  malformedResponse,

  /// The request could not be built (a bad base URL or path).
  invalidRequest,

  /// A failure this version of the plugin does not know.
  unknown,
}

/// The merchant backend failed a call.
final class BackendException extends IndiaSubscriptionsException {
  const BackendException(
    super.message, {
    required this.kind,
    this.statusCode,
    this.serverCode,
    this.provider,
    this.providerCode,
    this.retryable,
  });

  final BackendFailureKind kind;
  final int? statusCode;

  /// The `code` of the server's error body (`VALIDATION`, `NOT_FOUND`, ...).
  final String? serverCode;
  final String? provider;
  final String? providerCode;
  final bool? retryable;
}

/// What stopped a purchase before the store's screen.
enum PurchaseErrorKind {
  /// Another purchase is still running.
  purchaseInProgress,

  /// The session has no option for this platform's store.
  noStoreOption,

  /// The session is `failed` or `expired`.
  sessionNotOpen,

  /// The server's checkout instruction cannot be used.
  invalidInstruction,

  /// The store does not know the product id the session named.
  productNotFound,

  /// The product is in the store but not the base plan or offer the session
  /// named (Android).
  offerNotAvailable,

  /// The activity the purchase was started from is gone (Android).
  activityGone,

  /// The store's own API failed.
  storeFailure,

  /// The record store failed to read or write.
  storage,

  /// The store returned a result the SDK does not know.
  unknownPurchaseResult,

  /// A failure this version of the plugin does not know.
  unknown,
}

/// The native SDK refused to run the purchase.
final class PurchaseStartException extends IndiaSubscriptionsException {
  const PurchaseStartException(
    super.message, {
    required this.kind,
    required this.rawKind,
  });

  final PurchaseErrorKind kind;

  /// The native SDK's name for the failure.
  final String rawKind;
}

/// Anything else the native side threw.
final class PlatformFailureException extends IndiaSubscriptionsException {
  const PlatformFailureException(super.message, {required this.code});
  final String code;
}

/// Error codes the native side sends.
abstract final class HostErrorCode {
  static const notConfigured = 'not_configured';
  static const backend = 'backend';
  static const purchase = 'purchase';
  static const unsupportedOnPlatform = 'unsupported_on_platform';
}

/// Turns a [PlatformException] from the host API into a typed exception.
IndiaSubscriptionsException translateError(PlatformException error) {
  final message = error.message ?? error.code;
  final details = error.details is Map
      ? Map<Object?, Object?>.from(error.details as Map)
      : const <Object?, Object?>{};
  switch (error.code) {
    case HostErrorCode.notConfigured:
      return NotConfiguredException(message);
    case HostErrorCode.unsupportedOnPlatform:
      return UnsupportedOnPlatformException(
        message,
        method: details['method'] as String? ?? '',
        platform: details['platform'] as String? ?? '',
      );
    case HostErrorCode.backend:
      return BackendException(
        message,
        kind:
            _byName(BackendFailureKind.values, details['kind']) ??
            BackendFailureKind.unknown,
        statusCode: details['statusCode'] as int?,
        serverCode: details['serverCode'] as String?,
        provider: details['provider'] as String?,
        providerCode: details['providerCode'] as String?,
        retryable: details['retryable'] as bool?,
      );
    case HostErrorCode.purchase:
      final raw = details['kind'] as String? ?? '';
      return PurchaseStartException(
        message,
        kind:
            _byName(PurchaseErrorKind.values, raw) ?? PurchaseErrorKind.unknown,
        rawKind: raw,
      );
    default:
      return PlatformFailureException(message, code: error.code);
  }
}

T? _byName<T extends Enum>(List<T> values, Object? name) {
  for (final value in values) {
    if (value.name == name) return value;
  }
  return null;
}
