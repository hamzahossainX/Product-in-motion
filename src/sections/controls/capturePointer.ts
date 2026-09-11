/**
 * Pointer capture, without the exception.
 *
 * `setPointerCapture` and `releasePointerCapture` throw NotFoundError if the
 * pointer is no longer active — which happens for real when a pointer is
 * cancelled between the event being queued and the handler running, and also
 * for any synthetic PointerEvent, which has no backing pointer at all. Capture
 * is an enhancement here: without it a drag that leaves the element stops,
 * which is a worse drag, not a broken page.
 */
export function capturePointer(attempt: () => void): void {
  try {
    attempt();
  } catch {
    /* the pointer is already gone; the drag simply loses capture */
  }
}
