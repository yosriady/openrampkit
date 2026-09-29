import '@rainbow-me/rainbowkit/styles.css'
import './globals.css'
import type { ReactNode } from 'react'
import { Providers } from '@/components/Providers'

export const metadata = { title: 'OpenRampKit playground', description: 'Open-source deposit and withdraw kit' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
