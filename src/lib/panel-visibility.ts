/**
 * Deferring a panel's automatic work until it is actually on screen.
 *
 * All five panels are mounted at startup and only hidden with `hidden`, so a panel nobody is
 * looking at still hears every tab change. Without this, switching browser tabs would inject
 * collectors into every frame of the page on behalf of panels the reader cannot see.
 */

export const PANEL_SHOWN_EVENT = "ht:shown";

/** The newest deferred work per container — a reader who switches tabs twice only wants the last. */
const pending = new WeakMap<HTMLElement, () => void>();

/** Runs `work` now if `container` is on screen, otherwise when it is next shown. */
export function whenVisible(container: HTMLElement, work: () => void): void {
  if (!container.hidden) {
    work();
    return;
  }

  if (!pending.has(container)) {
    container.addEventListener(
      PANEL_SHOWN_EVENT,
      () => {
        const queued = pending.get(container);
        pending.delete(container);
        queued?.();
      },
      { once: true },
    );
  }
  pending.set(container, work);
}
