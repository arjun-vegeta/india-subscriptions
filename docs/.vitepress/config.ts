import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

// Links from a page to files outside docs/ (the README, CONTRIBUTING.md, .env.example, clients/, openapi/, scripts/) work
// on GitHub but are not pages of this site, so the dead-link check skips them. test/docs/links.test.ts checks them.
const OUTSIDE_DOCS = /^(\.\/)?(\.\.\/)+(README\.md|CONTRIBUTING\.md|\.env\.example|clients\/|openapi\/|scripts\/|sdks\/|src\/|test\/)/;

export default withMermaid(
  defineConfig({
    title: 'india-subscriptions',
    description: 'One headless API for subscriptions and payments on Indian payment gateways and app stores.',
    lang: 'en',
    cleanUrls: true,
    srcExclude: ['README.md', 'node_modules/**'],
    ignoreDeadLinks: [OUTSIDE_DOCS],
    themeConfig: {
      nav: [
        { text: 'Get started', link: '/getting-started/first-subscription' },
        { text: 'Concepts', link: '/concepts/recurring-payments' },
        { text: 'Guides', link: '/guides/checkout' },
        { text: 'Mobile', link: '/guides/mobile-apps' },
        { text: 'Gateways', link: '/gateways/razorpay' },
        { text: 'Reference', link: '/reference/' },
      ],
      sidebar: [
        {
          text: 'Getting started',
          items: [
            { text: 'Overview', link: '/' },
            { text: 'Installation', link: '/getting-started/installation' },
            { text: 'Your first subscription', link: '/getting-started/first-subscription' },
            { text: 'Using it from any language', link: '/getting-started/any-language' },
          ],
        },
        {
          text: 'Concepts',
          items: [
            { text: 'How recurring payments work', link: '/concepts/recurring-payments' },
            { text: 'The subscription lifecycle', link: '/concepts/lifecycle' },
            { text: 'Trials, delayed starts, upfront amounts', link: '/concepts/trials' },
            { text: 'Gateway and merchant scheduling', link: '/concepts/scheduling' },
            { text: 'Events', link: '/concepts/events' },
            { text: 'Entitlements', link: '/concepts/entitlements' },
            { text: 'Money and time', link: '/concepts/money-and-time' },
            { text: 'Errors', link: '/concepts/errors' },
          ],
        },
        {
          text: 'Guides',
          items: [
            { text: 'Checkout in the browser', link: '/guides/checkout' },
            { text: 'Handling webhooks', link: '/guides/webhooks' },
            { text: 'One-time payments', link: '/guides/one-time-payments' },
            { text: 'Routing', link: '/guides/routing' },
            { text: 'Selling on iPhone, Android and the web', link: '/guides/purchases' },
            { text: 'Setting up the App Store', link: '/guides/setting-up-app-store' },
            { text: 'Setting up Google Play', link: '/guides/setting-up-google-play' },
            { text: 'Mobile apps: iOS, Android, React Native, Flutter', link: '/guides/mobile-apps' },
            { text: 'Managing subscriptions', link: '/guides/managing-subscriptions' },
            { text: 'Running the scheduler', link: '/guides/scheduler' },
            { text: 'Running the HTTP service', link: '/guides/http-service' },
            { text: 'Security checklist', link: '/guides/security' },
            { text: 'Testing your integration', link: '/guides/testing' },
            { text: 'Going-live checklist', link: '/guides/going-live' },
          ],
        },
        {
          text: 'Gateways',
          items: [
            { text: 'Razorpay', link: '/gateways/razorpay' },
            { text: 'Cashfree', link: '/gateways/cashfree' },
            { text: 'PayU', link: '/gateways/payu' },
            { text: 'PhonePe', link: '/gateways/phonepe' },
            { text: 'Paytm', link: '/gateways/paytm' },
            { text: 'Apple App Store', link: '/gateways/app-store' },
            { text: 'Google Play', link: '/gateways/google-play' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'Overview', link: '/reference/' },
            { text: 'The client', link: '/reference/client' },
            { text: 'The billing scheduler', link: '/reference/scheduler' },
            { text: 'The checkout helper', link: '/reference/checkout' },
            { text: 'The HTTP service functions', link: '/reference/http-service' },
            { text: 'PostgreSQL stores', link: '/reference/postgres' },
            { text: 'The Python client', link: '/reference/python-client' },
          ],
        },
        {
          text: 'Generated reference',
          collapsed: true,
          items: [
            { text: 'Models', link: '/reference/generated/models' },
            { text: 'Enumerations', link: '/reference/generated/enums' },
            { text: 'Scheduler records', link: '/reference/generated/scheduler-records' },
            { text: 'HTTP API', link: '/reference/generated/http-api' },
            { text: 'Environment variables', link: '/reference/generated/environment' },
            { text: 'Errors', link: '/reference/generated/errors' },
            { text: 'Capability matrix', link: '/reference/generated/capabilities' },
            { text: 'Routing', link: '/reference/generated/routing' },
            { text: 'Purchases', link: '/reference/generated/purchases' },
          ],
        },
        {
          text: 'Contributing',
          items: [
            { text: 'Architecture', link: '/contributing/architecture' },
            { text: 'Adding a gateway', link: '/contributing/adding-a-gateway' },
          ],
        },
      ],
      search: { provider: 'local' },
      outline: [2, 3],
      footer: { message: 'Released under the MIT license.' },
    },
    mermaid: {},
  }),
);
