// Lazy loader for the web component package. Never runs on the server.
type WebModule = typeof import('@openrampkit/web')

let loading: Promise<WebModule> | undefined

export function loadWeb(): Promise<WebModule> {
  if (typeof window === 'undefined') return Promise.reject(new Error('@openrampkit/solid: the modal can only open in the browser.'))
  loading ??= import('@openrampkit/web').then((m) => {
    m.defineOpenRampModal()
    return m
  })
  return loading
}
