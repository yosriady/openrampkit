/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  transpilePackages: ['@openrampkit/web', '@openrampkit/react', '@openrampkit/client', '@openrampkit/core'],
  webpack: (config) => {
    config.externals.push('pino-pretty', 'lokijs', 'encoding')
    // wagmi's Base Account connector pulls in optional Coinbase SDK code that imports a package
    // which is not installed. The demo does not use it, so resolve it to an empty module.
    config.resolve.alias = { ...config.resolve.alias, '@coinbase/cdp-sdk': false }
    return config
  },
}
