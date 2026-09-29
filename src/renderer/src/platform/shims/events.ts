/** Small stand-in for node:events, so the shared desktop services (which extend EventEmitter) run in the phone app. */
type Listener = (...args: any[]) => void

export class EventEmitter {
  private listenersByEvent = new Map<string, Set<Listener>>()

  on(event: string, fn: Listener): this {
    const set = this.listenersByEvent.get(event) ?? new Set<Listener>()
    set.add(fn)
    this.listenersByEvent.set(event, set)
    return this
  }
  addListener(event: string, fn: Listener): this {
    return this.on(event, fn)
  }
  once(event: string, fn: Listener): this {
    const wrapper: Listener = (...args) => {
      this.off(event, wrapper)
      fn(...args)
    }
    return this.on(event, wrapper)
  }
  off(event: string, fn: Listener): this {
    this.listenersByEvent.get(event)?.delete(fn)
    return this
  }
  removeListener(event: string, fn: Listener): this {
    return this.off(event, fn)
  }
  removeAllListeners(event?: string): this {
    if (event) this.listenersByEvent.delete(event)
    else this.listenersByEvent.clear()
    return this
  }
  emit(event: string, ...args: unknown[]): boolean {
    const set = this.listenersByEvent.get(event)
    if (!set || set.size === 0) return false
    for (const fn of [...set]) {
      try {
        fn(...args)
      } catch (err) {
        console.error(`[events] listener for "${event}" threw`, err)
      }
    }
    return true
  }
  listenerCount(event: string): number {
    return this.listenersByEvent.get(event)?.size ?? 0
  }
  setMaxListeners(): this {
    return this
  }
}

export default EventEmitter
