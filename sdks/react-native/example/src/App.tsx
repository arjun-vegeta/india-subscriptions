import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Linking,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  addPurchaseListener,
  configure,
  entitlements,
  getSubscriptionManagementUrl,
  handleReturnLink,
  processPendingPurchases,
  purchase,
  restorePurchases,
  setAuthorization,
  showManageSubscriptions,
  start,
  type PurchaseEvent,
  type PurchaseOutcome,
} from 'india-subscriptions-react-native';

// Your backend (the one that forwards the five calls to the india-subscriptions service) and the signed-in user.
const BACKEND_URL = 'https://api.example.com/billing/';
const CUSTOMER_REF = 'customer_123';
const PRODUCT = 'pro_monthly';
const RETURN_URL = 'indiasubscriptionsexample://billing/return';

function describeOutcome(outcome: PurchaseOutcome): string {
  switch (outcome.type) {
    case 'completed':
      return 'Welcome to Pro.';
    case 'pending':
      return 'Waiting for approval.';
    case 'cancelled':
      return 'Cancelled.';
    case 'awaitingBackend':
      return 'Confirming your purchase...';
    case 'awaitingReturn':
      return 'Finish the payment in the browser.';
    case 'rejected':
    case 'unverified':
    case 'failed':
      return `The purchase did not go through (${outcome.type}).`;
    default:
      return `Something happened: ${outcome.name}`;
  }
}

function describeEvent(event: PurchaseEvent): string {
  return event.type === 'unknown' ? `unknown: ${event.name}` : event.type;
}

export default function App() {
  const [status, setStatus] = useState('Starting...');
  const [events, setEvents] = useState<string[]>([]);

  const checkAccess = useCallback(async () => {
    const owned = await entitlements(CUSTOMER_REF);
    setStatus(
      owned.items.some((item) => item.product === PRODUCT && item.active)
        ? 'Pro is active.'
        : 'No active purchase.'
    );
  }, []);

  useEffect(() => {
    // Order: configure, listen, start.
    let subscription: { remove(): void } | undefined;
    (async () => {
      try {
        await configure({
          baseUrl: BACKEND_URL,
          authorization: 'Bearer <the signed-in user token>',
        });
        subscription = addPurchaseListener((event) => {
          setEvents((all) => [describeEvent(event), ...all].slice(0, 20));
          if (event.type === 'completed') {
            setStatus('Welcome to Pro.');
          }
        });
        await start();
        setStatus('Ready.');
      } catch (error) {
        setStatus(`Setup failed: ${String(error)}`);
      }
    })();
    return () => subscription?.remove();
  }, []);

  // Android: the app is opened again through its return link after a hosted checkout.
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }
    const read = async (url: string | null | undefined) => {
      if (url) {
        const result = await handleReturnLink(url);
        if (result.type === 'completed') {
          await checkAccess();
        }
      }
    };
    Linking.getInitialURL().then(read);
    const subscription = Linking.addEventListener('url', ({ url }) => {
      read(url);
    });
    return () => subscription.remove();
  }, [checkAccess]);

  const buy = async () => {
    try {
      const outcome = await purchase(PRODUCT, {
        customerRef: CUSTOMER_REF,
        customer: { name: 'Asha', state: 'Karnataka' },
        returnUrl: RETURN_URL,
      });
      setStatus(describeOutcome(outcome));
    } catch (error) {
      setStatus(`Could not start the purchase: ${String(error)}`);
    }
  };

  const manage = async () => {
    if (Platform.OS === 'ios') {
      await showManageSubscriptions();
    } else {
      await Linking.openURL(await getSubscriptionManagementUrl(PRODUCT));
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>India Subscriptions</Text>
        <Text>{status}</Text>
        <View style={styles.buttons}>
          <Button title="Subscribe" onPress={buy} />
          <Button
            title="Restore purchases"
            onPress={async () => {
              await restorePurchases(CUSTOMER_REF);
              await checkAccess();
            }}
          />
          <Button title="Manage subscription" onPress={manage} />
          <Button
            title="Retry pending"
            onPress={async () => {
              await processPendingPurchases();
            }}
          />
          <Button
            title="Token changed"
            onPress={() => setAuthorization('Bearer <a fresh token>')}
          />
        </View>
        {events.map((line, index) => (
          <Text key={index} style={styles.event}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, gap: 12 },
  title: { fontSize: 22, fontWeight: '600' },
  buttons: { gap: 8 },
  event: { fontFamily: 'Menlo', fontSize: 12 },
});
