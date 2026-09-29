import { createElement, Fragment, useCallback, useRef } from 'react'
import type { ReactNode } from 'react'
import type { OrkError, OrkEvent, PublicSession } from '@openrampkit/core'
import { useOpenRamp } from './provider.js'

export type DepositButtonRenderProps = {
  /** Opens the deposit modal */
  open: () => void
  isOpen: boolean
}

export type DepositButtonCustomProps = {
  /** A client secret, or a function that fetches one from your server */
  getClientSecret: string | (() => Promise<string>)
  onComplete?: (session: PublicSession) => void
  /** Called when the modal closes before the deposit completes */
  onError?: (error: OrkError) => void
  onEvent?: (e: OrkEvent) => void
  children: (props: DepositButtonRenderProps) => ReactNode
}

export type DepositButtonProps = Omit<DepositButtonCustomProps, 'children'> & {
  label?: ReactNode
  className?: string
  disabled?: boolean
}

function useOpen(p: Omit<DepositButtonCustomProps, 'children'>): DepositButtonRenderProps {
  const { beginDeposit, isOpen } = useOpenRamp()
  const props = useRef(p)
  props.current = p
  const open = useCallback(() => {
    const c = props.current
    beginDeposit({ clientSecret: c.getClientSecret, ...(c.onEvent ? { onEvent: c.onEvent } : {}) }).then(
      (s) => props.current.onComplete?.(s),
      (e: OrkError) => props.current.onError?.(e),
    )
  }, [beginDeposit])
  return { open, isOpen }
}

function Custom(props: DepositButtonCustomProps) {
  return createElement(Fragment, null, props.children(useOpen(props)))
}

/** A ready-made "Deposit" button. Use `DepositButton.Custom` for your own markup, like RainbowKit's `ConnectButton.Custom`. */
export function DepositButton(props: DepositButtonProps) {
  const { open, isOpen } = useOpen(props)
  return createElement(
    'button',
    { type: 'button', className: props.className, disabled: props.disabled || isOpen, onClick: open },
    props.label ?? 'Deposit',
  )
}

DepositButton.Custom = Custom
