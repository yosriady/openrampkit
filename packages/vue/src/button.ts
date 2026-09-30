import { defineComponent, h } from 'vue'
import type { DefineComponent, PropType, Ref } from 'vue'
import type { OrkError, OrkEvent, PublicSession } from '@openrampkit/core'
import { useOpenRamp } from './provider.js'

export type DepositButtonSlotProps = {
  /** Opens the modal */
  open: () => void
  isOpen: boolean
}
export type WithdrawButtonSlotProps = DepositButtonSlotProps

type Kind = 'deposit' | 'withdraw'

const customProps = {
  /** A client secret, or a function that fetches one from your server */
  getClientSecret: { type: [String, Function] as PropType<string | (() => Promise<string>)>, required: true as const },
  onComplete: Function as PropType<(session: PublicSession) => void>,
  /** Called when the modal closes before the session completes */
  onError: Function as PropType<(error: OrkError) => void>,
  onEvent: Function as PropType<(e: OrkEvent) => void>,
}

export type DepositButtonCustomProps = {
  /** A client secret, or a function that fetches one from your server */
  getClientSecret: string | (() => Promise<string>)
  onComplete?: ((session: PublicSession) => void) | undefined
  /** Called when the modal closes before the session completes */
  onError?: ((error: OrkError) => void) | undefined
  onEvent?: ((e: OrkEvent) => void) | undefined
}
export type DepositButtonProps = DepositButtonCustomProps & {
  /** Button text. The default slot takes precedence. */
  label?: string
  disabled?: boolean
}
export type WithdrawButtonCustomProps = DepositButtonCustomProps
export type WithdrawButtonProps = DepositButtonProps

/** A button component with a renderless `Custom` variant */
export type ButtonComponent = DefineComponent<DepositButtonProps> & { Custom: DefineComponent<DepositButtonCustomProps> }

function useOpen(kind: Kind, props: DepositButtonCustomProps): { open: () => void; isOpen: Readonly<Ref<boolean>> } {
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

function makeButton(kind: Kind, name: string, defaultLabel: string): ButtonComponent {
  const Custom = defineComponent({
    name: `${name}Custom`,
    props: customProps,
    setup(props, { slots }) {
      const { open, isOpen } = useOpen(kind, props)
      return () => slots.default?.({ open, isOpen: isOpen.value } satisfies DepositButtonSlotProps)
    },
  })
  const Button = defineComponent({
    name,
    props: {
      ...customProps,
      /** Button text. The default slot takes precedence. */
      label: String,
      disabled: Boolean,
    },
    setup(props, { slots }) {
      const { open, isOpen } = useOpen(kind, props)
      return () => h('button', { type: 'button', disabled: props.disabled || isOpen.value, onClick: open }, slots.default?.() ?? props.label ?? defaultLabel)
    },
  })
  // Declared types keep the published .d.ts small and stable across Vue versions.
  return Object.assign(Button, { Custom }) as unknown as ButtonComponent
}

/**
 * A ready-made "Deposit" button. The default slot or `label` sets the text. Listen with `@complete`, `@error`, `@event`.
 * Use `DepositButton.Custom` (or `DepositButtonCustom`) for your own markup: its default slot gets `{ open, isOpen }`.
 */
export const DepositButton = makeButton('deposit', 'DepositButton', 'Deposit')
export const DepositButtonCustom: DefineComponent<DepositButtonCustomProps> = DepositButton.Custom

/**
 * A ready-made "Withdraw" button for a withdraw session. Use `WithdrawButton.Custom` for your own markup.
 * `getClientSecret` must return the secret of a session created with `direction: 'withdraw'`.
 */
export const WithdrawButton = makeButton('withdraw', 'WithdrawButton', 'Withdraw')
export const WithdrawButtonCustom: DefineComponent<WithdrawButtonCustomProps> = WithdrawButton.Custom
