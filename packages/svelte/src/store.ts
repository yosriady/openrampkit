// A minimal store that follows the Svelte store contract, so `$store` works in Svelte 4 and 5 components.

/** The Svelte store contract: `subscribe` calls `run` at once with the current value, then on each change. */
export type Readable<T> = {
  subscribe(run: (value: T) => void): () => void
}

export type Writable<T> = Readable<T> & {
  get(): T
  set(value: T): void
}

export function writable<T>(value: T): Writable<T> {
  const subs = new Set<(value: T) => void>()
  return {
    get: () => value,
    set(v) {
      if (Object.is(v, value)) return
      value = v
      for (const run of [...subs]) run(v)
    },
    subscribe(run) {
      subs.add(run)
      run(value)
      return () => {
        subs.delete(run)
      }
    },
  }
}
