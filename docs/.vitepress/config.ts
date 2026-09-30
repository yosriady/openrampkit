import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'OpenRampKit',
  description: 'Open-source deposit and withdraw kit: one modal, your server, pluggable adapters.',
  cleanUrls: true,
  lastUpdated: true,
  // The design notes link to local files outside the site; do not fail the build on those.
  ignoreDeadLinks: [/^\.\.\/\.\.\//, /localhost/],
  srcExclude: ['**/node_modules/**', 'README.md'],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/introduction' },
      { text: 'Concepts', link: '/concepts/pathways' },
      { text: 'Adapters', link: '/adapters/' },
      { text: 'API', link: '/api/server' },
      { text: 'Deploy', link: '/deploy/cloudflare-workers' },
      { text: 'Design', link: '/design/scope' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Getting started',
          items: [
            { text: 'Introduction', link: '/guide/introduction' },
            { text: 'Prerequisites', link: '/guide/prerequisites' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Quick start (Next.js)', link: '/guide/quick-start-nextjs' },
            { text: 'Without React (web component)', link: '/guide/web-component' },
            { text: 'Merchant fiat destination', link: '/guide/merchant-destination' },
            { text: 'Withdrawals', link: '/guide/withdraw' },
            { text: 'Theming', link: '/guide/theming' },
            { text: 'Webhooks to your backend', link: '/guide/webhooks' },
            { text: 'Testing with mocks', link: '/guide/testing' },
            { text: 'Examples', link: '/guide/examples' },
          ],
        },
      ],
      '/concepts/': [
        {
          text: 'Concepts',
          items: [
            { text: 'Architecture', link: '/concepts/architecture' },
            { text: 'Pathways and legs', link: '/concepts/pathways' },
            { text: 'Sessions and security', link: '/concepts/sessions' },
            { text: 'Flow state machine', link: '/concepts/flow' },
            { text: 'Surfaces', link: '/concepts/surfaces' },
            { text: 'Events', link: '/concepts/events' },
          ],
        },
      ],
      '/adapters/': [
        {
          text: 'Adapters',
          items: [
            { text: 'Overview', link: '/adapters/' },
            { text: 'Relay', link: '/adapters/relay' },
            { text: 'Swapped', link: '/adapters/swapped' },
            { text: 'Xendit', link: '/adapters/xendit' },
            { text: 'Coinbase', link: '/adapters/coinbase' },
            { text: 'Transak', link: '/adapters/transak' },
            { text: 'MoonPay', link: '/adapters/moonpay' },
            { text: 'Stripe', link: '/adapters/stripe' },
            { text: 'Meld', link: '/adapters/meld' },
            { text: 'Onramper', link: '/adapters/onramper' },
            { text: 'Peer', link: '/adapters/peer' },
            { text: 'Mock', link: '/adapters/mock' },
            { text: 'Wallets (wagmi)', link: '/adapters/wagmi' },
            { text: 'Writing an adapter', link: '/adapters/writing-an-adapter' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API reference',
          items: [
            { text: '@openrampkit/server', link: '/api/server' },
            { text: 'HTTP routes', link: '/api/http' },
            { text: '@openrampkit/client', link: '/api/client' },
            { text: '@openrampkit/web', link: '/api/web' },
            { text: '@openrampkit/react', link: '/api/react' },
            { text: '@openrampkit/vue', link: '/api/vue' },
            { text: '@openrampkit/svelte', link: '/api/svelte' },
            { text: '@openrampkit/solid', link: '/api/solid' },
            { text: '@openrampkit/core', link: '/api/core' },
            { text: '@openrampkit/adapter', link: '/api/adapter' },
          ],
        },
      ],
      '/deploy/': [
        {
          text: 'Deploy',
          items: [
            { text: 'Cloudflare Workers', link: '/deploy/cloudflare-workers' },
            { text: 'Next.js / Vercel', link: '/deploy/nextjs' },
            { text: 'Node, Bun, Deno', link: '/deploy/node' },
            { text: 'Session stores', link: '/deploy/stores' },
            { text: 'Production checklist', link: '/deploy/checklist' },
          ],
        },
      ],
      '/design/': [
        {
          text: 'Design notes',
          items: [
            { text: 'Scope', link: '/design/scope' },
            { text: 'Spec and phases', link: '/design/spec' },
            { text: 'Market landscape', link: '/design/landscape' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/yosriady/openrampkit' }],
    search: { provider: 'local' },
    editLink: { pattern: 'https://github.com/yosriady/openrampkit/edit/main/docs/:path' },
    footer: { message: 'MIT licensed', copyright: 'OpenRampKit contributors' },
  },
})
