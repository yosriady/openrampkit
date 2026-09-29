import { createElement, Fragment, useCallback, useRef } from 'react'
import type { ReactNode } from 'react'
import type { OrkError, OrkEvent, PublicSession } from '@openrampkit/core'
import { useOpenRamp } from './provider.js'

export type DepositButtonRenderProps = {
  /** Opens the modal */
  open: () => void
  isOpen: boolean
}

export type DepositButtonCustomProps = {
  /** A client secret, or a function that fetches one from your server */
  getClientSecret: string | (() => Promise<string>)
  onComplete?: (session: PublicSession) => void
  /** Called when the modal closes before the session completes */
  onError?: (error: OrkError) => void
  onEvent?: (e: OrkEvent) => void
  children: (props: DepositButtonRenderProps) => ReactNode
}

export type DepositButtonProps = Omit<DepositButtonCustomProps, 'children'> & {
  label?: ReactNode
  className?: string
  disabled?: boolean
}

export type WithdrawButtonRenderProps = DepositButtonRenderProps
export type WithdrawButtonCustomProps = Omit<DepositButtonCustomProps, 'children'> & { children: (props: WithdrawButtonRenderProps) => ReactNode }
export type WithdrawButtonProps = DepositButtonProps

type Kind = 'deposit' | 'withdraw'

function useOpen(kind: Kind, p: Omit<DepositButtonCustomProps, 'children'>): DepositButtonRenderProps {
  const { beginDeposit, beginWithdraw, isOpen } = useOpenRamp()
  const props = useRef(p)
  props.current = p
  const open = useCallback(() => {
    const c = props.current
    const begin = kind === 'withdraw' ? beginWithdraw : beginDeposit
    begin({ clientSecret: c.getClientSecret, ...(c.onEvent ? { onEvent: c.onEvent } : {}) }).then(
      (s) => props.current.onComplete?.(s),
      (e: OrkError) => props.current.onError?.(e),
    )
  }, [kind, beginDeposit, beginWithdraw])
  return { open, isOpen }
}

function makeButton(kind: Kind, defaultLabel: string) {
  function Custom(props: DepositButtonCustomProps) {
    return createElement(Fragment, null, props.children(useOpen(kind, props)))
  }
  function Button(props: DepositButtonProps) {
    const { open, isOpen } = useOpen(kind, props)
    return createElement(
      'button',
      { type: 'button', className: props.className, disabled: props.disabled || isOpen, onClick: open },
      props.label ?? defaultLabel,
    )
  }
  Button.Custom = Custom
  return Button
}

/** A ready-made "Deposit" button. Use `DepositButton.Custom` for your own markup, like RainbowKit's `ConnectButton.Custom`. */
export const DepositButton = makeButton('deposit', 'Deposit')

/**
 * A ready-made "Withdraw" button for a withdraw session. Use `WithdrawButton.Custom` for your own markup.
 * `getClientSecret` must return the secret of a session created with `direction: 'withdraw'`.
 */
export const WithdrawButton = makeButton('withdraw', 'Withdraw')
