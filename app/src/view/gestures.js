// Pointer input on a viewport: taps, drags (handed to the active tool),
// two-finger pinch / pan, long press, mouse wheel and trackpad pinch.

const TAP_SLOP_TOUCH = 10;
const TAP_SLOP_MOUSE = 4;
const LONG_PRESS_MS = 450;
const DOUBLE_TAP_MS = 320;

/**
 * @param {HTMLElement} el
 * @param {object} h handlers:
 *   down(x, y, e)               any pointer down (activate the view)
 *   tap(x, y, e)                single tap / click
 *   doubleTap(x, y, e)
 *   dragStart(x, y, e) -> {move(x, y, dx, dy, e), end(e), cancel()} | null
 *   pinch(scale, cx, cy, dx, dy)
 *   longPress(x, y, e) -> {move(x, y), end()} | null
 *   wheel(e, x, y)
 *   hover(x, y, e) / leave()
 */
export function attachGestures(el, h) {
  const pointers = new Map();
  let gesture = null; // {type: 'pending'|'drag'|'pinch'|'long'|'dead', ...}
  let lastTap = null;

  const local = (e) => {
    const r = el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  function clearLong() {
    if (gesture && gesture.longTimer) {
      clearTimeout(gesture.longTimer);
      gesture.longTimer = null;
    }
  }

  function startPinch() {
    clearLong();
    if (gesture?.type === 'drag') gesture.handler?.cancel?.();
    if (gesture?.type === 'long') gesture.handler?.end?.();
    const [a, b] = [...pointers.values()];
    gesture = {
      type: 'pinch',
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
    };
  }

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button === 1) e.preventDefault();
    const [x, y] = local(e);
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // ignore (synthetic events)
    }
    pointers.set(e.pointerId, {x, y, type: e.pointerType});
    h.down?.(x, y, e);
    if (pointers.size === 2) {
      startPinch();
      return;
    }
    if (pointers.size > 2) return;
    gesture = {
      type: 'pending',
      x0: x,
      y0: y,
      x,
      y,
      t0: performance.now(),
      button: e.button,
      pointerType: e.pointerType,
      id: e.pointerId,
    };
    if (e.pointerType !== 'mouse' && h.longPress) {
      gesture.longTimer = setTimeout(() => {
        if (!gesture || gesture.type !== 'pending') return;
        const handler = h.longPress(gesture.x, gesture.y, e);
        if (handler) gesture = {...gesture, type: 'long', handler};
      }, LONG_PRESS_MS);
    }
  });

  el.addEventListener('pointermove', (e) => {
    const [x, y] = local(e);
    const p = pointers.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse') h.hover?.(x, y, e);
      return;
    }
    const px = p.x;
    const py = p.y;
    p.x = x;
    p.y = y;
    if (!gesture) return;
    if (gesture.type === 'pinch') {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const scale = gesture.dist > 0 ? dist / gesture.dist : 1;
      h.pinch?.(scale, cx, cy, cx - gesture.cx, cy - gesture.cy);
      gesture.dist = dist;
      gesture.cx = cx;
      gesture.cy = cy;
      return;
    }
    if (e.pointerId !== gesture.id) return;
    if (gesture.type === 'long') {
      gesture.handler.move?.(x, y);
      return;
    }
    if (gesture.type === 'pending') {
      const slop = gesture.pointerType === 'mouse' ? TAP_SLOP_MOUSE : TAP_SLOP_TOUCH;
      if (Math.hypot(x - gesture.x0, y - gesture.y0) < slop) return;
      clearLong();
      const handler = h.dragStart?.(gesture.x0, gesture.y0, e, gesture.button);
      if (!handler) {
        gesture.type = 'dead';
        return;
      }
      gesture.type = 'drag';
      gesture.handler = handler;
      handler.move(x, y, x - gesture.x0, y - gesture.y0, e);
      gesture.x = x;
      gesture.y = y;
      return;
    }
    if (gesture.type === 'drag') {
      gesture.handler.move(x, y, x - px, y - py, e);
      gesture.x = x;
      gesture.y = y;
    }
  });

  function finish(e, cancelled) {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (!p || !gesture) return;
    if (gesture.type === 'pinch') {
      // the remaining finger does nothing until it is lifted too
      if (pointers.size < 2) gesture = pointers.size ? {type: 'dead'} : null;
      return;
    }
    if (e.pointerId !== gesture.id && gesture.type !== 'dead') return;
    clearLong();
    const [x, y] = local(e);
    if (gesture.type === 'drag') {
      if (cancelled) gesture.handler.cancel?.(); else gesture.handler.end?.(e);
    } else if (gesture.type === 'long') {
      gesture.handler.end?.();
    } else if (gesture.type === 'pending' && !cancelled && (gesture.button === 0 || gesture.button === undefined || gesture.button === -1)) {
      const now = performance.now();
      if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(x - lastTap.x, y - lastTap.y) < 30) {
        lastTap = null;
        h.doubleTap?.(x, y, e);
      } else {
        lastTap = {t: now, x, y};
        h.tap?.(x, y, e);
      }
    }
    if (!pointers.size) gesture = null;
  }

  el.addEventListener('pointerup', (e) => finish(e, false));
  el.addEventListener('pointercancel', (e) => finish(e, true));
  el.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && !pointers.size) h.leave?.();
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [x, y] = local(e);
    h.wheel?.(e, x, y);
  }, {passive: false});

  // Safari trackpad pinch
  let gestureScale = 1;
  el.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    gestureScale = 1;
  });
  el.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    // iOS also sends these for touch pinches, which pointer events handle
    if (pointers.size) return;
    const [x, y] = local(e);
    h.pinch?.(e.scale / gestureScale, x, y, 0, 0);
    gestureScale = e.scale;
  });
  el.addEventListener('gestureend', (e) => e.preventDefault());

  // double click with a mouse arrives as two taps above; nothing else needed
  return {
    cancel() {
      if (gesture?.type === 'drag') gesture.handler.cancel?.();
      gesture = null;
    },
  };
}
