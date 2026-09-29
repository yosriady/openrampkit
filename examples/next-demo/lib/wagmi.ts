import { connectorsForWallets } from '@rainbow-me/rainbowkit'
import { injectedWallet, metaMaskWallet, rabbyWallet } from '@rainbow-me/rainbowkit/wallets'
import { createConfig, http } from 'wagmi'
import { arbitrum, base, mainnet, optimism, polygon } from 'wagmi/chains'

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'demo-project-id'

// Browser wallets only, so the demo works without a WalletConnect project id.
const connectors = connectorsForWallets(
  [{ groupName: 'Browser wallets', wallets: [injectedWallet, metaMaskWallet, rabbyWallet] }],
  { appName: 'OpenRampKit playground', projectId },
)

export const wagmiConfig = createConfig({
  connectors,
  chains: [base, arbitrum, optimism, polygon, mainnet],
  transports: { [base.id]: http(), [arbitrum.id]: http(), [optimism.id]: http(), [polygon.id]: http(), [mainnet.id]: http() },
  ssr: true,
})
