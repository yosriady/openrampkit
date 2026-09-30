import { createComponent, untrack } from 'solid-js'
import type { Accessor, JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import type { OrkError, OrkEvent, PublicSession } from '@openrampkit/core'
import { useOpenRamp } from './provider.js'

export type DepositButtonRenderProps = {
  /** Opens the modal */
  open: () => void
  /** Whether the modal is open */
  isOpen: Accessor<boolean>
}

export type DepositButtonCustomProps = {
  /** A client secret, or a function that fetches one from your server */
  getClientSecret: string | (() => Promise<string>)
  onComplete?: (session: PublicSession) => void
  /** Called when the modal closes before the session completes */
  onError?: (error: OrkError) => void
  onEvent?: (e: OrkEvent) => void
  children: (props: DepositButtonRenderProps) => JSX.Element
}

export type DepositButtonProps = Omit<DepositButtonCustomProps, 'children'> & {
  label?: JSX.Element
  class?: string
  disabled?: boolean
}

export type WithdrawButtonRenderProps = DepositButtonRenderProps
export type WithdrawButtonCustomProps = DepositButtonCustomProps
export type WithdrawButtonProps = DepositButtonProps

type Kind = 'deposit' | 'withdraw'

function useOpen(kind: Kind, props: Omit<DepositButtonCustomProps, 'children'>): DepositButtonRenderProps {
  const { beginDeposit, beginWithdraw, isOpen } = useOpenRamp()
  const open = () => {
    const begin = kind === 'withdraw' ? beginWithdraw : beginDeposit
    begin({ clientSecret: props.getClientSecret, ...(props.onEvent ? { onEvent: props.onEvent } : {}) }).then(
      (s) => props.onComplete?.(s),
      (e: OrkError) => props.onError?.(e),
    )
  }
  return { open, isOpen }
}

function makeButton(kind: Kind, defaultLabel: string) {
  function Custom(props: DepositButtonCustomProps): JSX.Element {
    const renderProps = useOpen(kind, props)
    return untrack(() => props.children(renderProps))
  }
  function Button(props: DepositButtonProps): JSX.Element {
    const { open, isOpen } = useOpen(kind, props)
    return createComponent(Dynamic<'button'>, {
      component: 'button',
      type: 'button',
      get class() {
        return props.class
      },
      get disabled() {
        return !!props.disabled || isOpen()
      },
      onClick: () => open(),
      get children() {
        return props.label ?? defaultLabel
      },
    })
  }
  Button.Custom = Custom
  return Button
}

/** A ready-made "Deposit" button. Use `DepositButton.Custom` for your own markup. */
export const DepositButton = makeButton('deposit', 'Deposit')

/**
 * A ready-made "Withdraw" button for a withdraw session. Use `WithdrawButton.Custom` for your own markup.
 * `getClientSecret` must return the secret of a session created with `direction: 'withdraw'`.
 */
export const WithdrawButton = makeButton('withdraw', 'Withdraw')
