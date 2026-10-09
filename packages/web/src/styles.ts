import { css, unsafeCSS } from 'lit'
import { themeVariables } from './theme.js'

const toCss = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([k, v]) => `${k}: ${v};`)
    .join('\n')

// Defaults live on :host so the element looks right before any theme is applied.
// The element also writes resolved variables as inline styles, which win over these.
const lightVars = unsafeCSS(toCss(themeVariables(undefined, undefined, 'light')))
const darkVars = unsafeCSS(toCss(themeVariables(undefined, undefined, 'dark')))

export const styles = css`
  :host {
    ${lightVars}
    display: contents;
    color-scheme: light;
  }
  :host([data-mode='dark']) {
    ${darkVars}
    color-scheme: dark;
  }
  @media (prefers-color-scheme: dark) {
    :host([data-mode='auto']) {
      ${darkVars}
      color-scheme: dark;
    }
  }
  :host([embedded]) {
    display: block;
  }

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  .overlay {
    position: fixed;
    inset: 0;
    z-index: 2147483000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: var(--ork-color-overlay);
    animation: ork-fade 160ms ease-out;
  }

  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 400px;
    max-width: 100%;
    max-height: min(720px, calc(100vh - 32px));
    max-height: min(720px, calc(100dvh - 32px));
    background: var(--ork-color-background);
    color: var(--ork-color-text);
    border: var(--ork-border-width) solid var(--ork-color-border);
    border-radius: var(--ork-radius-card);
    box-shadow: var(--ork-shadow-card);
    font-family: var(--ork-font-family);
    font-size: 15px;
    line-height: 1.4;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
    outline: none;
    animation: ork-pop 180ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
  }
  :host([embedded]) .card {
    width: 100%;
    max-width: 400px;
    max-height: none;
    box-shadow: none;
    animation: none;
  }

  @media (max-width: 479px) {
    .overlay {
      align-items: flex-end;
      padding: 0;
    }
    .overlay .card {
      width: 100%;
      max-height: 92vh;
      max-height: 92dvh;
      border-radius: var(--ork-radius-card) var(--ork-radius-card) 0 0;
      border-bottom: none;
      animation: ork-sheet 220ms cubic-bezier(0.2, 0.9, 0.3, 1);
      padding-bottom: env(safe-area-inset-bottom, 0px);
    }
  }

  @keyframes ork-fade {
    from {
      opacity: 0;
    }
  }
  @keyframes ork-pop {
    from {
      opacity: 0;
      transform: scale(0.96) translateY(6px);
    }
  }
  @keyframes ork-sheet {
    from {
      transform: translateY(100%);
    }
  }
  @keyframes ork-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes ork-shimmer {
    0% {
      opacity: 0.55;
    }
    50% {
      opacity: 1;
    }
    100% {
      opacity: 0.55;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .overlay,
    .card,
    .overlay .card,
    .skeleton {
      animation: none !important;
    }
    .spinner {
      animation-duration: 2s !important;
    }
    * {
      transition: none !important;
    }
    .row:active:not(:disabled),
    .btn:active:not(:disabled),
    .icon-btn:active {
      transform: none;
    }
  }

  /* header */
  .header {
    display: grid;
    grid-template-columns: 36px 1fr 36px;
    align-items: center;
    gap: 8px;
    padding: 14px 16px 6px;
    min-height: 56px;
  }
  .title {
    margin: 0;
    text-align: center;
    font-size: 17px;
    font-weight: 650;
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    outline: none;
  }
  .title-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-width: 0;
  }
  .logo {
    width: 22px;
    height: 22px;
    border-radius: 6px;
    object-fit: cover;
  }
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: none;
    border-radius: 999px;
    background: var(--ork-color-surface);
    color: var(--ork-color-text-secondary);
    cursor: pointer;
    transition: background 120ms, color 120ms, transform 120ms;
  }
  .icon-btn:hover {
    background: var(--ork-color-surface-hover);
    color: var(--ork-color-text);
  }
  .icon-btn:active {
    transform: scale(0.94);
  }
  .icon-btn svg {
    width: 18px;
    height: 18px;
  }

  .body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 16px 16px;
    overscroll-behavior: contain;
  }
  .footer {
    padding: 0 16px 12px;
    text-align: center;
    font-size: 11px;
    color: var(--ork-color-text-muted);
  }

  /* focus */
  button:focus-visible,
  input:focus-visible,
  select:focus-visible,
  a:focus-visible,
  iframe:focus-visible,
  [tabindex]:not([tabindex='-1']):focus-visible {
    outline: 2px solid var(--ork-color-focus);
    outline-offset: 2px;
  }

  /* segmented tabs */
  .tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    padding: 4px;
    margin-bottom: 12px;
    background: var(--ork-color-surface);
    border-radius: calc(var(--ork-radius-button) + 2px);
  }
  .tab {
    padding: 8px 12px;
    border: none;
    border-radius: var(--ork-radius-button);
    background: transparent;
    color: var(--ork-color-text-secondary);
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: background 120ms, color 120ms, box-shadow 120ms;
  }
  .tab[aria-selected='true'] {
    background: var(--ork-color-background);
    color: var(--ork-color-text);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1), 0 0 0 var(--ork-border-width) var(--ork-color-border);
  }

  /* groups and rows */
  .group + .group {
    margin-top: 14px;
  }
  .group-label {
    margin: 0 0 6px 4px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ork-color-text-muted);
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 12px;
    border: var(--ork-border-width) solid transparent;
    border-radius: var(--ork-radius-row);
    background: var(--ork-color-surface);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 120ms, border-color 120ms, transform 120ms;
  }
  .row:hover:not(:disabled) {
    background: var(--ork-color-surface-hover);
  }
  .row:active:not(:disabled) {
    transform: scale(0.99);
  }
  .row:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .row[aria-checked='true'] {
    border-color: var(--ork-color-accent);
    background: var(--ork-color-accent-soft);
  }
  .row-icon {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: var(--ork-color-background);
    color: var(--ork-color-accent);
    border: var(--ork-border-width) solid var(--ork-color-border);
  }
  .row-icon svg {
    width: 20px;
    height: 20px;
  }
  .row-main {
    flex: 1;
    min-width: 0;
  }
  .row-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row-sub {
    display: block;
    margin-top: 2px;
    font-size: 13px;
    color: var(--ork-color-text-secondary);
    overflow-wrap: anywhere;
  }
  .row-end {
    flex: none;
    text-align: right;
    font-size: 13px;
    color: var(--ork-color-text-secondary);
  }
  .row-end strong {
    display: block;
    font-size: 15px;
    color: var(--ork-color-text);
  }
  .chevron {
    flex: none;
    width: 16px;
    height: 16px;
    color: var(--ork-color-text-muted);
  }

  .badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 7px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 650;
    line-height: 16px;
    background: var(--ork-color-accent-soft);
    color: var(--ork-color-text);
  }
  .badge.success {
    background: var(--ork-color-success-soft);
    color: var(--ork-color-success);
  }

  /* amount */
  .amount-box {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 28px 12px 20px;
  }
  .amount-input-wrap {
    display: flex;
    align-items: baseline;
    justify-content: center;
    max-width: 100%;
    font-size: 48px;
    font-weight: 650;
    letter-spacing: -0.02em;
  }
  .amount-prefix {
    color: var(--ork-color-text-muted);
    margin-right: 4px;
    font-size: 0.7em;
  }
  .amount-suffix {
    color: var(--ork-color-text-muted);
    margin-left: 8px;
    font-size: 0.45em;
  }
  .amount-input {
    min-width: 1ch;
    max-width: 100%;
    border: none;
    background: transparent;
    color: var(--ork-color-text);
    font: inherit;
    text-align: center;
    outline: none;
    padding: 0;
  }
  .amount-input:focus-visible {
    outline: none;
  }
  .amount-input::placeholder {
    color: var(--ork-color-text-muted);
  }
  .amount-wrap-focus:focus-within {
    outline: 2px solid var(--ork-color-focus);
    outline-offset: 6px;
    border-radius: 8px;
  }
  .hint {
    margin-top: 8px;
    font-size: 13px;
    color: var(--ork-color-text-muted);
    text-align: center;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    margin: 4px 0 16px;
  }
  .chip {
    padding: 7px 14px;
    border: var(--ork-border-width) solid var(--ork-color-border);
    border-radius: 999px;
    background: var(--ork-color-background);
    color: var(--ork-color-text);
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: background 120ms, border-color 120ms;
  }
  .chip:hover {
    background: var(--ork-color-surface);
  }
  .chip[aria-pressed='true'] {
    border-color: var(--ork-color-accent);
    background: var(--ork-color-accent-soft);
    color: var(--ork-color-text);
  }

  .field-label {
    display: block;
    margin: 0 0 6px 4px;
    font-size: 13px;
    font-weight: 600;
    color: var(--ork-color-text-secondary);
  }
  .select-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 14px;
  }
  .input,
  select.input {
    width: 100%;
    padding: 11px 12px;
    border: var(--ork-border-width) solid var(--ork-color-border);
    border-radius: var(--ork-radius-input);
    background: var(--ork-color-surface);
    color: var(--ork-color-text);
    font: inherit;
  }
  /* One look in Chrome, Safari and Firefox: no native arrow, our chevron centred 12px from the right */
  select.input {
    -webkit-appearance: none;
    -moz-appearance: none;
    appearance: none;
    height: 44px;
    padding-top: 0;
    padding-bottom: 0;
    padding-right: 36px;
    line-height: 1.25;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none' stroke='%238B93A2' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 4.5 6 7.5 9 4.5'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 12px center;
    background-size: 12px 12px;
  }
  select.input::-ms-expand {
    display: none;
  }
  .input:focus {
    border-color: var(--ork-color-accent);
  }
  .input.mono {
    font-family: var(--ork-font-mono);
    font-size: 14px;
  }
  .input[aria-invalid='true'] {
    border-color: var(--ork-color-danger);
  }
  .field-error {
    margin: 6px 0 0 4px;
    font-size: 13px;
    color: var(--ork-color-danger);
  }
  .target-summary {
    margin-top: 4px;
    font-size: 13px;
    color: var(--ork-color-text-muted);
    text-align: center;
    word-break: break-all;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .checkbox {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 14px;
  }

  /* buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    min-height: 48px;
    padding: 12px 16px;
    border: var(--ork-border-width) solid transparent;
    border-radius: var(--ork-radius-button);
    background: var(--ork-color-accent);
    color: var(--ork-color-accent-text);
    font: inherit;
    font-size: 16px;
    font-weight: 650;
    cursor: pointer;
    /* Do not transition filter. In WebKit, a filter transition that runs together with the opacity
       transition (the hover brightness goes away as the clicked button turns disabled) can crash the
       page. The hover brightness changes at once. */
    transition: transform 120ms, opacity 120ms;
    text-decoration: none;
  }
  .btn:hover:not(:disabled) {
    filter: brightness(1.06);
  }
  .btn:active:not(:disabled) {
    transform: scale(0.985);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn.secondary {
    background: var(--ork-color-surface);
    color: var(--ork-color-text);
    border-color: var(--ork-color-border);
  }
  .btn.ghost {
    background: transparent;
    color: var(--ork-color-text-secondary);
    min-height: 40px;
    font-size: 14px;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 16px;
  }

  .spinner {
    width: 18px;
    height: 18px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 999px;
    animation: ork-spin 700ms linear infinite;
    flex: none;
  }
  .spinner.large {
    width: 32px;
    height: 32px;
    border-width: 3px;
    color: var(--ork-color-accent);
  }
  .center {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 24px 8px;
    text-align: center;
  }
  .muted {
    color: var(--ork-color-text-muted);
    font-size: 13px;
  }
  .secondary-text {
    color: var(--ork-color-text-secondary);
    font-size: 14px;
  }
  .status-line {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-top: 12px;
    font-size: 13px;
    color: var(--ork-color-text-secondary);
  }
  .status-line .spinner {
    width: 14px;
    height: 14px;
  }

  .skeleton {
    height: 62px;
    border-radius: var(--ork-radius-row);
    background: var(--ork-color-surface);
    animation: ork-shimmer 1.2s ease-in-out infinite;
  }
  .skeleton + .skeleton {
    margin-top: 6px;
  }

  /* notices */
  .notice {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin-top: 12px;
    padding: 10px 12px;
    border-radius: var(--ork-radius-row);
    font-size: 13px;
    line-height: 1.45;
  }
  .notice svg {
    flex: none;
    width: 16px;
    height: 16px;
    margin-top: 1px;
  }
  .provider-sdk {
    min-height: 420px;
  }
  .notice.error {
    background: var(--ork-color-danger-soft);
    color: var(--ork-color-danger);
  }
  .notice.warning {
    background: var(--ork-color-warning-soft);
    color: var(--ork-color-warning);
  }
  .notice.info {
    background: var(--ork-color-surface);
    color: var(--ork-color-text-secondary);
  }

  /* QR and copy */
  .qr {
    display: flex;
    justify-content: center;
    padding: 14px;
    margin: 4px auto 12px;
    width: fit-content;
    background: #ffffff;
    border-radius: var(--ork-radius-row);
    border: var(--ork-border-width) solid var(--ork-color-border);
  }
  .qr svg {
    display: block;
    width: 200px;
    height: 200px;
  }
  .big-amount {
    text-align: center;
    font-size: 26px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .kv {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 12px;
  }
  .kv-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: var(--ork-radius-row);
    background: var(--ork-color-surface);
  }
  .kv-main {
    flex: 1;
    min-width: 0;
  }
  .kv-label {
    font-size: 12px;
    color: var(--ork-color-text-muted);
  }
  .kv-value {
    font-weight: 600;
    word-break: break-all;
  }
  .kv-value.mono {
    font-family: var(--ork-font-mono);
    font-size: 13px;
    font-weight: 500;
  }
  .copy-btn {
    flex: none;
    padding: 6px 10px;
    border: var(--ork-border-width) solid var(--ork-color-border);
    border-radius: 999px;
    background: var(--ork-color-background);
    color: var(--ork-color-text);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .copy-btn[data-copied] {
    color: var(--ork-color-success);
    border-color: var(--ork-color-success);
  }

  iframe.provider {
    display: block;
    width: 100%;
    border: var(--ork-border-width) solid var(--ork-color-border);
    border-radius: var(--ork-radius-row);
    background: #fff;
  }

  /* progress */
  .progress {
    margin: 16px 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .progress li {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 14px;
  }
  .dot {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
    background: var(--ork-color-surface);
    color: var(--ork-color-text-secondary);
    border: var(--ork-border-width) solid var(--ork-color-border);
  }
  .dot.succeeded {
    background: var(--ork-color-success);
    border-color: var(--ork-color-success);
    color: var(--ork-color-background);
  }
  .dot.processing,
  .dot.requires_action {
    background: var(--ork-color-accent-soft);
    border-color: var(--ork-color-accent);
    color: var(--ork-color-text);
  }
  .dot.failed,
  .dot.expired {
    background: var(--ork-color-danger-soft);
    border-color: var(--ork-color-danger);
    color: var(--ork-color-danger);
  }
  .progress .leg-status {
    color: var(--ork-color-text-secondary);
  }

  /* result */
  .result-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 64px;
    height: 64px;
    border-radius: 999px;
  }
  .result-icon svg {
    width: 32px;
    height: 32px;
  }
  .result-icon.success {
    background: var(--ork-color-success-soft);
    color: var(--ork-color-success);
  }
  .result-icon.failure {
    background: var(--ork-color-danger-soft);
    color: var(--ork-color-danger);
  }
  .result-title {
    margin: 4px 0 0;
    font-size: 20px;
    font-weight: 700;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* Touch targets: at least 44 by 44 px on phones and touch screens */
  @media (pointer: coarse), (max-width: 479px) {
    .header {
      grid-template-columns: 44px 1fr 44px;
    }
    .icon-btn {
      width: 44px;
      height: 44px;
    }
    .tab,
    .chip,
    .btn.ghost {
      min-height: 44px;
    }
    .copy-btn {
      min-width: 44px;
      min-height: 44px;
      padding: 6px 14px;
    }
    .checkbox {
      min-height: 44px;
    }
    .amount-input {
      min-width: 44px;
    }
  }

  /* Windows high contrast: keep the selected state visible without background colors */
  @media (forced-colors: active) {
    .tab[aria-selected='true'],
    .chip[aria-pressed='true'],
    .row[aria-checked='true'] {
      outline: 2px solid Highlight;
    }
  }
`
