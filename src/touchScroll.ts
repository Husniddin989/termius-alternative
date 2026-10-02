import type { Terminal } from "@xterm/xterm";

/**
 * Swipe-to-scroll for phones: xterm.js has no touch scrolling of its own.
 * In the normal screen a swipe moves through the scrollback (with momentum);
 * in full-screen programs (less, vim, htop) it sends arrow keys instead,
 * like other mobile terminals. Taps are left alone so they still focus the
 * terminal and open the keyboard.
 */
export function attachTouchScroll(el: HTMLElement, term: Terminal, send: (data: string) => void): () => void {
  const THRESHOLD = 8; // px before a touch counts as a swipe
  let startY = 0;
  let lastY = 0;
  let lastT = 0;
  let carry = 0; // px not yet turned into whole lines
  let velocity = 0; // px per ms
  let swiping = false;
  let frame = 0;

  const rowHeight = () => {
    const screen = el.querySelector(".xterm-screen");
    return screen && term.rows ? screen.getBoundingClientRect().height / term.rows : 18;
  };

  /** Positive = towards older output. */
  const scrollBy = (lines: number) => {
    if (lines === 0) return;
    if (term.buffer.active.type === "alternate") {
      const prefix = term.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[";
      send((prefix + (lines > 0 ? "A" : "B")).repeat(Math.min(Math.abs(lines), 20)));
    } else {
      term.scrollLines(-lines);
    }
  };

  const consume = (dy: number) => {
    const h = rowHeight();
    carry += dy;
    const lines = Math.trunc(carry / h);
    if (lines !== 0) {
      carry -= lines * h;
      scrollBy(lines);
    }
  };

  const stopMomentum = () => {
    cancelAnimationFrame(frame);
    frame = 0;
  };

  const onStart = (e: TouchEvent) => {
    stopMomentum();
    if (e.touches.length !== 1) return;
    startY = lastY = e.touches[0].clientY;
    lastT = performance.now();
    carry = 0;
    velocity = 0;
    swiping = false;
  };

  const onMove = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    if (!swiping && Math.abs(y - startY) < THRESHOLD) return;
    swiping = true;
    e.preventDefault();
    e.stopPropagation();
    const now = performance.now();
    const dy = y - lastY;
    velocity = 0.8 * (dy / Math.max(1, now - lastT)) + 0.2 * velocity;
    lastY = y;
    lastT = now;
    consume(dy);
  };

  const onEnd = (e: TouchEvent) => {
    if (!swiping) return;
    e.preventDefault(); // no synthetic click after a swipe
    swiping = false;
    // Momentum only in the scrollback; in full-screen apps it would spam keys.
    if (term.buffer.active.type === "alternate" || Math.abs(velocity) < 0.3) return;
    let prev = performance.now();
    const step = (now: number) => {
      const dt = now - prev;
      prev = now;
      velocity *= Math.pow(0.995, dt);
      if (Math.abs(velocity) < 0.05) return stopMomentum();
      consume(velocity * dt);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };

  const opts = { capture: true, passive: false } as const;
  el.addEventListener("touchstart", onStart, opts);
  el.addEventListener("touchmove", onMove, opts);
  el.addEventListener("touchend", onEnd, opts);
  el.addEventListener("touchcancel", onEnd, opts);
  return () => {
    stopMomentum();
    el.removeEventListener("touchstart", onStart, opts);
    el.removeEventListener("touchmove", onMove, opts);
    el.removeEventListener("touchend", onEnd, opts);
    el.removeEventListener("touchcancel", onEnd, opts);
  };
}
