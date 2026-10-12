// @ts-check
// Pen, finger and mouse on the page canvas (B:canvas.py input handling; PORTING.md 7.2).
// One pointer-events state machine for the three kinds of pointer. The GTK-specific workarounds
// (raw pen events, the compositor "nudge") are not ported; `drop` (the stroke abandoned when
// something else asks, unless the pen is writing) and the input log are.
import { PageCanvas, RULER_W, SIDE, PULL } from './canvas.js';
import { mono } from '../core/clock.js';

const PEN_TIMES = { stale: 350 };
// iPadOS reports the Pencil's force as a share of the hardest press it can tell (about 4.17
// times an ordinary one); A works in UIKit's units, where an ordinary press is 1.
const APPLE = typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
const FORCE_UNIT = APPLE ? 25 / 6 : 1;
/** The pen in use tells how hard it is pressed; decided by the last stroke, as in A. */
let penForce = true;
const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.max(lo, Math.min(hi, v));

/** @type {Record<string, (...args: any[]) => any>} */
const methods = {
  /** Start listening on the canvas element. */
  attachInput() {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const el = cv.el;
    el.addEventListener('pointerdown', e => cv._pointerDown(e));
    el.addEventListener('pointermove', e => cv._pointerMove(e));
    el.addEventListener('pointerup', e => cv._pointerUp(e));
    el.addEventListener('pointercancel', e => cv._pointerCancel(e));
    // A capture lost without a lift ends the stroke. WebKit reports the capture the previous stroke
    // gave up only once the pen is down again (same pointer id): by then the canvas holds the new
    // capture, and that late report must not end the stroke that has just begun.
    el.addEventListener('lostpointercapture', e => {
      if (e.pointerType !== 'pen' || !cv.penDown || cv.penId !== e.pointerId) return;
      if (el.hasPointerCapture(e.pointerId) || mono() - cv.penDownAt < 120) { cv.log('late lostpointercapture ignored'); return; }
      cv._pointerUp(e);
    });
    el.addEventListener('pointerleave', () => { if (cv.hover) { cv.hover = null; cv.queueDraw(); } });
    el.addEventListener('wheel', e => cv._wheel(e), { passive: false });
    for (const t of ['contextmenu', 'selectstart', 'dragstart']) el.addEventListener(t, e => e.preventDefault());
    // iOS: the system's own recognisers (double tap, Scribble, text selection) take a touch away from
    // the page unless its touch events are refused; the second of two quick strokes drawn close
    // together went that way. The pointer events this file works with still arrive.
    for (const t of ['touchstart', 'touchmove', 'touchend']) el.addEventListener(t, e => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    // Safari's own pinch events; the page must not zoom itself.
    let base = 1;
    el.addEventListener('gesturestart', /** @type {any} */ (e => { e.preventDefault(); base = cv.zoom; }));
    el.addEventListener('gesturechange', /** @type {any} */ (e => { e.preventDefault(); const r = el.getBoundingClientRect(); cv.setZoom(base * e.scale, e.clientX - r.left, e.clientY - r.top); }));
    el.addEventListener('gestureend', e => e.preventDefault());
    el.addEventListener('keydown', e => cv._key(e));
  },

  /** @param {PointerEvent} e @returns {[number, number]} */
  _pt(e) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const r = cv.el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  },

  /** @param {PointerEvent} e */
  _pointerDown(e) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const [x, y] = cv._pt(e);
    cv.ptr = [x, y];
    if (e.pointerType === 'pen') cv._penDown(e, x, y);
    else if (e.pointerType === 'touch') cv._touchDown(e, x, y);
    else cv._mouseDownEvent(e, x, y);
  },

  /** @param {PointerEvent} e */
  _pointerMove(e) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const [x, y] = cv._pt(e);
    cv.ptr = [x, y];
    if (e.pointerType === 'pen') {
      cv.hasPen = true;
      cv.penSeen = mono();
      if (cv.penDown && e.pointerId === cv.penId) cv._penMove(e);
      else cv._hover(x, y, e);
    } else if (e.pointerType === 'touch') {
      if (cv.touches.has(e.pointerId)) { cv.touches.set(e.pointerId, [x, y]); cv._touchUpdate(); }
    } else {
      cv._mouseMove(e, x, y);
    }
  },

  /** @param {PointerEvent} e */
  _pointerUp(e) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const [x, y] = cv._pt(e);
    if (e.pointerType === 'pen') {
      if (cv.penDown && e.pointerId === cv.penId) {
        cv.penDown = false;
        cv.log(`pen up, was drawing: ${cv.op ? cv.op.kind : null}`);
        cv.up(x, y);
      }
    } else if (e.pointerType === 'touch') {
      cv.rejected.delete(e.pointerId);
      if (cv.touches.delete(e.pointerId)) cv._touchReset(x, y, true);
    } else {
      cv._mouseUp(e, x, y);
    }
  },

  /** @param {PointerEvent} e */
  _pointerCancel(e) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const [x, y] = cv._pt(e);
    if (e.pointerType === 'pen') {
      cv.log(`pen cancelled, id ${e.pointerId}, was drawing: ${cv.op ? cv.op.kind : null}`);
      if (cv.penDown && e.pointerId === cv.penId) {
        // The system took the pen away mid-stroke. What was written stays: ink that vanishes is
        // worse than a stroke cut short. Anything else that was under way is given up.
        cv.penDown = false;
        if (cv.op && cv.op.kind === 'stroke') cv.up(...cv.penAt); else cv.drop('the pen was cancelled');
      }
    } else if (e.pointerType === 'touch') {
      cv.rejected.delete(e.pointerId);
      if (cv.touches.delete(e.pointerId)) cv._touchReset(x, y, false);
    } else {
      cv.drop('the mouse was cancelled');
    }
  },

  /** Something other than the pen wants the stroke in progress abandoned. While the pen is
   * writing nothing else may do that; otherwise it is cancelled as asked. @param {string} why */
  drop(why) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    if (cv.penDown) { cv.log('kept the pen stroke although: ' + why); return; }
    if (cv.op) cv.log(`cancelled ${cv.op.kind}: ${why}`);
    cv.cancel();
  },

  // -- the pen ------------------------------------------------------------------------------------

  /** How hard the pen writes, 0..1 (A:CanvasTools.swift pressure). @param {PointerEvent} e */
  _penPressure(e) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const st = cv.pst;
    // The line thins with speed. The time is the sample's own: the samples of one frame arrive
    // together, and the clock would call them simultaneous.
    const dt = (e.timeStamp - st.t) / 1000;
    if (dt > 0) {
      const speed = Math.hypot(cv.penAt[0] - st.at[0], cv.penAt[1] - st.at[1]) / dt;   // points a second
      const aim = clamp(0.95 - speed / 1700, 0.16, 0.92);
      cv.mouseP += (aim - cv.mouseP) * (1 - Math.exp(-dt / 0.045));
      st.at = cv.penAt;
      st.t = e.timeStamp;
    }
    // A pen without a pressure sensor (the USB-C Pencil) reports the same force all the time. It
    // is known by that, and its line is then shaped by speed alone, as a mouse's is.
    const force = e.pressure * FORCE_UNIT;
    st.n++;
    if (st.n === 1) st.first = force;
    else if (!st.varying && Math.abs(force - st.first) > 0.02) { st.varying = true; penForce = true; }
    else if (!st.varying && st.n === 12) penForce = false;
    if (!penForce || force <= 0) return clamp(0.5 + (cv.mouseP - 0.5) * 2, 0, 1);
    // Apple Pencil: an ordinary writing press is about 1, twice that is as hard as the pens answer
    // to; speed has its say beside the pressure. A tablet's pen is taken at its word (B:canvas.py).
    if (APPLE) return clamp(force / 2 + (cv.mouseP - 0.5) * 0.7, 0, 1);
    return clamp(force, 0.02, 1);
  },

  /** @param {PointerEvent} e @param {number} x @param {number} y */
  _penDown(e, x, y) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    cv.hasPen = true;
    cv.penSeen = mono();
    cv._palm();
    cv.log(`pen press: id ${e.pointerId}, button ${e.button}, buttons ${e.buttons}, pressure ${e.pressure.toFixed(2)}, touches ${cv.rejected.size}`);
    if (e.button !== 0 && e.button !== 5) return;   // a barrel button on its own presses without the tip touching
    if (cv.penDown) {
      // The lift before this never arrived: finish that stroke where it stopped.
      cv.log('pen press while still down: ending the earlier stroke');
      cv.penDown = false;
      cv.up(...cv.penAt);
    }
    try { cv.el.setPointerCapture(e.pointerId); } catch { /* gone */ }
    // The eraser end of the pen, or the barrel button held while writing, erases.
    const erase = e.button === 5 || (e.buttons & 32) !== 0 || (e.buttons & 2) !== 0 || (e.buttons & 4) !== 0;
    cv.penDown = true;
    cv.penDownAt = mono();
    cv.penId = e.pointerId;
    cv.src = 'pen';
    cv.penAt = [x, y];
    cv.pst = { n: 0, first: 0, varying: false, t: e.timeStamp, at: [x, y] };
    cv.mouseP = 0.5;
    cv.down(x, y, cv._penPressure(e), erase);
    cv.log(`pen down at ${x.toFixed(0)},${y.toFixed(0)} -> ${cv.op ? cv.op.kind : 'nothing (text, a selection grabbed, or outside every page)'}`);
  },

  /** @param {PointerEvent} e */
  _penMove(e) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const r = cv.el.getBoundingClientRect();
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    // The browser merges the samples of a frame into one event; the coalesced ones keep fast handwriting smooth.
    const list = events.length ? events : [e];
    for (const ev of list) {
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      cv.penAt = [x, y];
      cv.move(x, y, cv._penPressure(ev));
    }
  },

  // -- the mouse ------------------------------------------------------------------------------------

  /** @param {PointerEvent} e @param {number} x @param {number} y */
  _mouseDownEvent(e, x, y) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    if (e.button === 1) {   // middle button: moves the page
      e.preventDefault();
      cv.el.setPointerCapture(e.pointerId);
      cv.pan = [cv._h(), cv._v(), x, y, e.pointerId];
      return;
    }
    if (e.button !== 0) return;
    cv.el.setPointerCapture(e.pointerId);
    cv.el.focus({ preventScroll: true });
    cv.barDrag = cv._barAt(x, y);
    cv.barStart = [x, y];
    if (cv.barDrag) { cv.mouseId = e.pointerId; cv.queueDraw(); return; }
    if (cv.mouseHand && cv.hasPen && cv._rulerZone(x, y) === null) {
      // With a pen in use the mouse is a hand: it moves the page, and a click lifts tape.
      cv.hand = [cv._h(), cv._v(), x, y, false];
      cv.mouseId = e.pointerId;
      return;
    }
    cv.mouseDown = true;
    cv.mouseId = e.pointerId;
    cv.mouseP = 0.45;
    cv.mouseLast = [x, y];
    cv.mouseStart = [x, y];
    cv.src = 'mouse';
    cv.down(x, y, cv.mouseP, false);
  },

  /** @param {PointerEvent} e @param {number} x @param {number} y */
  _mouseMove(e, x, y) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    if (cv.pan && e.pointerId === cv.pan[4]) {
      const [h0, v0, x0, y0] = cv.pan;
      cv._scrollTo(h0 - (x - x0), v0 - (y - y0));
      return;
    }
    if (cv.barDrag && e.pointerId === cv.mouseId) {
      const [axis, lo, hi, perPixel, value] = cv.barDrag;
      const d = axis === 'v' ? y - cv.barStart[1] : x - cv.barStart[0];
      cv._setAdj(axis, clamp(value + d * perPixel, lo, hi));
      return;
    }
    if (cv.hand && e.pointerId === cv.mouseId) {
      const [h0, v0, x0, y0, moved] = cv.hand;
      if (moved || Math.hypot(x - x0, y - y0) > 4) {
        cv.hand = [h0, v0, x0, y0, true];
        cv._scrollBy(h0 - (x - x0) - cv._h(), v0 - (y - y0) - cv._v());
      }
      return;
    }
    if (!cv.mouseDown || e.pointerId !== cv.mouseId) { cv._hover(x, y, e); return; }
    // No pressure axis: thin the line with speed for a calligraphic feel.
    const r = cv.el.getBoundingClientRect();
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [e]) {
      const ex = ev.clientX - r.left, ey = ev.clientY - r.top;
      const speed = Math.hypot(ex - cv.mouseLast[0], ey - cv.mouseLast[1]);
      cv.mouseP = cv.mouseP * 0.75 + clamp(0.95 - speed / 45, 0.15, 0.85) * 0.25;
      cv.mouseLast = [ex, ey];
      cv.move(ex, ey, cv.mouseP);
    }
  },

  /** @param {PointerEvent} e @param {number} x @param {number} y */
  _mouseUp(e, x, y) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    if (cv.pan && e.pointerId === cv.pan[4]) { cv.pan = null; cv._rest([cv.zoom, cv._h(), cv._v()]); return; }
    if (e.pointerId !== cv.mouseId) return;
    if (cv.barDrag) { cv.barDrag = null; cv.queueDraw(); return; }
    if (cv.hand) {
      const hand = cv.hand;
      cv.hand = null;
      if (!hand[4]) cv.toggleTape(hand[2], hand[3]); else cv._rest([cv.zoom, hand[0], hand[1]]);
      return;
    }
    if (cv.mouseDown) { cv.mouseDown = false; cv.up(x, y); }
  },

  /** Where the pointer is, when nothing is pressed: the pen and mouse markers (set by the shell). @param {number} x @param {number} y @param {PointerEvent} e */
  _hover(x, y, e) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const was = cv.hover;
    cv.hover = e.pointerType === 'pen' || (cv.hasPen && e.pointerType === 'mouse') ? [x, y] : null;
    if (cv.hover || was) cv.queueDraw();
  },

  /** @param {KeyboardEvent} e */
  _key(e) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    if ((e.key === 'Delete' || e.key === 'Backspace') && cv.sel) { cv.deleteSelection(); e.preventDefault(); }
    else if (e.key === 'Escape') { cv.cancel(); cv.clearSelection(); }
  },

  // -- touch: pan, pinch and palm rejection ------------------------------------------------------------

  /** The pen is at the screen: whatever touches it now is the hand, so undo what it did. */
  _palm() {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    cv._stopFling();
    if (!cv.touches.size) return;
    for (const id of cv.touches.keys()) cv.rejected.add(id);
    cv.touches.clear();
    const g = cv.tg;
    cv.tg = null;
    if (!g) return;
    if (g.grab) {
      if (g.grab !== 'held') cv.cancel();   // the hand had hold of the selection: it goes back
    } else if (g.draw) {
      cv.drop('the hand that was drawing is a palm');
    } else if (g.moved) {
      // What the hand did as the pen came down is undone: the view goes back to where it was a
      // little before. A hand that has long been lying still changes nothing, and neither does
      // a pan that was finished well before the pen arrived.
      const now = mono();
      if (now - g.track[g.track.length - 1][0] > PEN_TIMES.stale) return;   // it last moved a while ago: that was meant
      let state = g.seen[0][1];
      for (let k = g.seen.length - 1; k >= 0; k--) if (now - g.seen[k][0] > PEN_TIMES.stale) { state = g.seen[k][1]; break; }
      if (state[0] === cv.zoom && state[1] === cv._h() && state[2] === cv._v()) return;
      cv.zoom = state[0];
      cv._relayout();
      cv._configureAdj(state[1], state[2]);
      cv._zoomChanged();
    }
  },

  _penActive() {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    return cv.penDown || mono() - cv.penSeen < cv.palmMs;
  },

  /** @param {PointerEvent} e @param {number} x @param {number} y */
  _touchDown(e, x, y) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    cv.el.focus({ preventScroll: true });
    if (cv._penActive()) {
      cv.rejected.add(e.pointerId);
      cv.log('touch ignored: the pen is at work');
      return;
    }
    try { cv.el.setPointerCapture(e.pointerId); } catch { /* gone */ }
    cv.log(`touch begins, ${cv.touches.size + 1} on the screen`);
    cv.touches.set(e.pointerId, [x, y]);
    cv._touchReset(x, y);
  },

  _touchShape() {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const pts = [...cv.touches.values()];
    const n = pts.length;
    const cx = pts.reduce((a, p) => a + p[0], 0) / n, cy = pts.reduce((a, p) => a + p[1], 0) / n;
    return [cx, cy, pts.reduce((a, p) => a + Math.hypot(p[0] - cx, p[1] - cy), 0) / n];
  },

  /** A finger came or went: restart the gesture from where the view is now. @param {number} x @param {number} y */
  _touchReset(x, y, lifted = false) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    let old = cv.tg;
    const n = cv.touches.size;
    cv._stopFling();
    cv.stopPress();
    if (old && old.grab) {
      if (cv._grabTouch(old, n, x, y, lifted)) return;
      old = null;
    }
    if (old && old.draw) {
      // A second finger turns a finger stroke into a pinch (unless the stroke has only just begun
      // or is very short: then it was the first finger of the pinch); lifting ends it.
      if (cv.penDown) { /* the pen has taken over; the finger's stroke is long gone */ }
      else if (n === 0 && lifted) cv.up(x, y);
      else if (cv._strokeInterrupted(old)) cv.drop('a finger stroke turned into a gesture');
      else cv.up(old.cx, old.cy);
    }
    if (n === 0) {
      cv.tg = null;
      const pages = cv.doc.pages.length;
      if (cv.pull) cv._pullRelease();
      if (old && cv._across() && old.over && old.page < cv.slots.length) {
        // Let go past the edge of a zoomed page: far enough turns it, less springs back.
        const i = old.page, over = old.over;
        const j = i + (over > 0 ? 1 : -1);
        if (Math.abs(over) > Math.max(110.0, 0.22 * cv.W) && j >= 0 && j < cv.slots.length) {
          cv.turning = j;
          cv._glide('h', cv._span(j)[j > i ? 0 : 1]);
        } else {
          cv.turning = i;
          cv._glide('h', cv._span(i)[over > 0 ? 1 : 0]);
        }
        return;
      }
      if (old && old.moved && !old.draw && cv.doc.pages.length === pages && cv._rest(old.origin, old.track)) {
        // side by side, the page in view comes to rest in the middle
      } else if (old && old.moved && !old.draw && old.n === 1 && lifted) {
        cv._startFling(old.track);
      } else if (old && lifted && !old.moved && !old.draw && !old.ruler && old.n === 1) {
        if (cv.tool === 'lasso') cv.pickAt(x, y);   // with the select tool a tap picks what is under it
        else cv.toggleTape(x, y);                   // a tap
      }
      return;
    }
    const [cx, cy, span] = cv._touchShape();
    const now = mono();
    const draw = n === 1 && !old && (cv.fingerDraw || cv.tool === 'laser');
    cv.tg = {
      n, cx, cy, span, zoom: cv.zoom, draw, moved: !!old && old.moved && !old.draw,
      t0: old ? old.t0 : now, t: now, track: [[now, cx, cy]],
      origin: old ? old.origin : [cv.zoom, cv._h(), cv._v()],
      anchor: cv._anchor(cx, cy), over: 0.0,
      seen: old ? old.seen : [[now, [cv.zoom, cv._h(), cv._v()]]],
      page: old ? old.page : (cv.tops.length && !cv.board ? cv.currentPageIndex() : 0),
    };
    if (cv._rulerZone(cx, cy)) {
      // Fingers on the ruler handle the ruler: one moves it, two also turn it.
      const pts = [...cv.touches.values()];
      Object.assign(cv.tg, { draw: false, ruler: { ...cv.ruler }, turn: n > 1 ? Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]) : null });
    } else if (cv.tool === 'lasso' && cv.sel && !old && n === 1 && !cv.penDown && cv.grabSelection(cx, cy, 22)) {
      // A finger on the selection carries it; at its edge, resizes it.
      cv.src = 'touch';
      Object.assign(cv.tg, { draw: true, grab: 'move' });
      cv.press(cx, cy);
    } else if (draw) {
      cv.src = 'touch';
      cv.down(cx, cy, 0.5, false);
    } else if (n === 1 && !old && cv.tool === 'lasso') {
      cv.press(cx, cy);
    }
  },

  /** A second finger turns a finger stroke into a pinch, but not if the stroke is only just
   * begun or short (A:strokeInterrupted): that finger was the first of a pinch. @param {any} g */
  _strokeInterrupted(g) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const pts = cv.op && cv.op.kind === 'stroke' ? cv.op.item.pts.length : 0;
    return !(mono() - g.t0 > 300 && pts >= 8) ? true : false;
  },

  /** Fingers that have hold of the selection: one moves or resizes it, a second one beside it
   * takes a copy along instead. True when that is all the fingers' coming or going meant. */
  _grabTouch(old, n, x, y, lifted) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const grab = old.grab;
    if (n === 0) {
      cv.tg = null;
      if (grab === 'move' || grab === 'copy') { if (lifted) cv.up(x, y); else cv.cancel(); }
      return true;
    }
    if (grab === 'move' && n === 2) {
      cv.cancel();
      const [cx, cy] = cv._touchShape();
      if (cv.copySelectionFrom(cx, cy)) { Object.assign(old, { grab: 'copy', n: 2 }); return true; }
      return false;   // the selection is gone: the fingers move the page
    }
    if (grab === 'move' || grab === 'copy') {
      // A finger more or less than the gesture needs ends it where it is.
      if (grab === 'copy') cv.up(old.cx, old.cy); else cv.cancel();
    }
    old.grab = 'held';   // nothing more until every finger is off the screen
    return true;
  },

  _touchUpdate() {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const g = cv.tg;
    if (!g) return;
    const [cx, cy, span] = cv._touchShape();
    if (g.ruler && cv.ruler) {
      const was = g.ruler;
      let turned = 0.0;
      if (g.turn !== null && cv.touches.size > 1) {
        const pts = [...cv.touches.values()];
        turned = Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]) - g.turn;
      }
      // It turns about the point between the fingers and follows them.
      const c = Math.cos(turned), s = Math.sin(turned);
      const vx = was.x - g.cx, vy = was.y - g.cy;
      cv.ruler.x = cx + vx * c - vy * s; cv.ruler.y = cy + vx * s + vy * c;
      cv._turnRuler(was.a + turned);
      g.moved = false;   // lifting the fingers must not fling the page
      return;
    }
    if (g.grab) {
      if (g.grab === 'move' || g.grab === 'copy') { g.cx = cx; g.cy = cy; cv.move(cx, cy, 0.5); }
      return;
    }
    if (g.draw) { g.cx = cx; g.cy = cy; cv.move(cx, cy, 0.5); return; }
    if (!g.moved) {
      // A small dead zone, so that a brush of the hand does not move the page.
      if (Math.hypot(cx - g.cx, cy - g.cy) < 8 && Math.abs(span - g.span) < 8) return;
      g.moved = true;
      cv.stopPress();
    }
    let zoom = g.zoom;
    if (g.n > 1 && g.span > 12) zoom = clamp(zoom * span / g.span, cv._minZoom(), cv._maxZoom());
    // The page point that was between the fingers stays between them.
    cv._place(zoom, g.anchor, cx, cy);
    g.over = 0.0;
    if (cv._across() && g.n === 1 && g.page < cv.slots.length && cv._span(g.page)[1] > cv._span(g.page)[0] + 1) {
      // Zoomed in, a finger moves about inside its page. Past the edge the page gives only a
      // little: it takes a long, deliberate pull to turn to the next one.
      const [lo, hi] = cv._span(g.page);
      const want = cv.want[0];
      g.over = want > hi ? want - hi : want < lo ? want - lo : 0.0;
      cv._setAdj('h', clamp(want, lo, hi) + 0.4 * g.over);
    } else if (cv._across() && g.n === 1 && Math.abs(g.origin[1] - cv._h()) < 1 && Math.abs(g.origin[0] - cv.zoom) < 1e-6) {
      // Only a drag that began with the first or last page at rest pulls a new one out; turning
      // to that page with too much of a swing does not.
      const over = cv.want[0] - cv._h();
      cv._pulled(Math.abs(over) > 1 ? over : 0.0);
    }
    const track = g.track;
    track.push([mono(), cx, cy]);
    if (track.length > 6) track.splice(0, track.length - 6);
    const seen = g.seen;
    if (track[track.length - 1][0] - seen[seen.length - 1][0] > 40) {   // the view at intervals, for the palm to be undone to
      seen.push([track[track.length - 1][0], [cv.zoom, cv._h(), cv._v()]]);
      while (seen.length > 2 && track[track.length - 1][0] - seen[1][0] > 350) seen.shift();
    }
  },

  /** Note that the view is being pushed past an end of a side-by-side notebook. @param {number} over */
  _pulled(over) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    if (!cv._across() || !cv.onPullAdd) return;
    if (over !== cv.pull) { cv.pull = over; cv.queueDraw(); }
  },

  /** Side by side, bring one whole page to rest in the window. origin is the [zoom, x, y] a drag
   * started from: a drag far or fast enough turns to the next page. False when there is nothing
   * to settle, as inside a page that is zoomed in past the window. @param {number[]} [origin] @param {any[]} [track] */
  _rest(origin, track) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    if (!cv._across() || !cv.slots.length) return false;
    const view = cv.W, h = cv._h();
    let i = cv._pageAt(h + view / 2, 0);
    const [lo, hi] = cv._span(i);
    if (hi > lo + 1) {
      // Zoomed in: the view belongs to one page and never rests across two.
      if (lo - 0.5 <= h && h <= hi + 0.5) return false;
      cv.turning = i;
      cv._glide('h', clamp(h, lo, hi));
      return true;
    }
    if (origin && Math.abs(origin[0] - cv.zoom) < 1e-6) {
      const start = cv._pageAt(origin[1] + view / 2, 0);
      const moved = h - origin[1];
      let speed = 0.0;
      if (track && track.length > 1 && track[track.length - 1][0] > track[0][0] && mono() - track[track.length - 1][0] < 60) {   // still moving when let go
        speed = (track[0][1] - track[track.length - 1][1]) / (track[track.length - 1][0] - track[0][0]) * 1000;
      }
      if (Math.abs(moved) > 0.18 * view || (Math.abs(speed) > 400 && speed * moved > 0)) i = clamp(start + (moved > 0 ? 1 : -1), 0, cv.slots.length - 1);
      else i = start;
    }
    if (Math.abs(cv.slots[i] - h) > 0.5) cv.scrollToPage(i);
    return true;
  },

  /** The pull was let go: far enough makes a page, otherwise it just springs back. */
  _pullRelease() {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const pull = cv.pull;
    cv.pull = 0.0;
    if (pull) {
      cv.queueDraw();
      if (Math.abs(pull) >= PULL && cv.onPullAdd) cv.onPullAdd(pull > 0 ? 1 : -1);
    }
  },

  /** @param {number} dx @param {number} dy */
  _scrollBy(dx, dy) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    if (cv.board) { cv._configureAdj(cv.bo[0] + dx, cv.bo[1] + dy); return; }
    let x = cv.sx + dx;
    if (cv._across() && cv.slots.length) {
      // Inside a zoomed page, gliding and dragging stop at its edge.
      const [lo, hi] = cv._span(cv.currentPageIndex());
      if (hi > lo + 1 && lo - 0.5 <= cv.sx && cv.sx <= hi + 0.5) x = clamp(x, lo, hi);
    }
    cv._configureAdj(x, cv.sy + dy);
  },

  /** @param {number} h @param {number} v */
  _scrollTo(h, v) { /** @type {PageCanvas} */ (/** @type {any} */ (this))._configureAdj(h, v); },

  /** @param {any[]} track */
  _startFling(track) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const [t1, x1, y1] = track[track.length - 1];
    const [t0, x0, y0] = track.find(/** @param {number[]} s */ s => t1 - s[0] < 90) || track[0];
    if (mono() - t1 > 60 || t1 - t0 < 8) return;
    let vx = (x0 - x1) / (t1 - t0) * 1000, vy = (y0 - y1) / (t1 - t0) * 1000;
    if (Math.hypot(vx, vy) < 250) return;
    let last = 0;
    const tick = (/** @type {number} */ now) => {
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      cv._scrollBy(vx * dt, vy * dt);
      const k = Math.exp(-4.0 * dt);
      vx *= k; vy *= k;
      if (Math.hypot(vx, vy) < 30) { cv.fling = 0; return; }
      cv.fling = requestAnimationFrame(tick);
    };
    cv.fling = requestAnimationFrame(tick);
  },

  _stopFling() {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    if (cv.fling) { cancelAnimationFrame(cv.fling); cv.fling = 0; }
  },

  // -- the wheel ----------------------------------------------------------------------------------------

  /** @param {WheelEvent} e */
  _wheel(e) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    e.preventDefault();
    const [x, y] = cv._pt(/** @type {any} */ (e));
    cv.ptr = [x, y];
    // A touchpad sends pixels in small steps; a wheel sends notches (a hundred or so pixels each, or lines).
    const wheelLike = e.deltaMode === 1 || (e.deltaMode === 0 && e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50 && (Math.abs(e.deltaY) % 100 === 0 || Math.abs(e.deltaY) % 120 === 0));
    const smooth = !wheelLike;
    const notch = (/** @type {number} */ d) => (e.deltaMode === 1 ? d / 3 : Math.sign(d) * Math.max(1, Math.round(Math.abs(d) / (Math.abs(d) % 120 === 0 ? 120 : 100))));
    const dx = smooth ? e.deltaX : notch(e.deltaX || 0) * (e.deltaX ? 1 : 0), dy = smooth ? e.deltaY : notch(e.deltaY || 0) * (e.deltaY ? 1 : 0);
    if (cv._rulerZone(x, y)) {
      // The wheel over the ruler turns it: a degree a notch, fifteen with Shift.
      const d = smooth ? (dy || dx) / 20 : (dy || dx);
      cv._turnRuler(cv.ruler.a + (d * (e.shiftKey ? 15 : 1)) * Math.PI / 180);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      cv.setZoom(cv.zoom * (smooth ? Math.exp(-dy * 0.01) : 1.1 ** -dy), x, y);
      return;
    }
    if (cv._across() && (dx || dy)) { cv._turnScroll(dx, dy, smooth); return; }
    let sdx = dx, sdy = dy;
    if (e.shiftKey && !sdx) [sdx, sdy] = [sdy, sdx];
    const step = smooth ? 1.0 : cv.board ? 48.0 : 60.0;
    cv._scrollBy(sdx * step, sdy * step);
  },

  /** Scrolling when the pages are side by side. It moves about inside a page that is larger than
   * the window; where there is nothing left to move, it turns the page: once per notch of a wheel,
   * once per swipe on a touchpad. It never pulls a new page out. @param {number} dx @param {number} dy @param {boolean} smooth */
  _turnScroll(dx, dy, smooth) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const upright = Math.abs(dy) >= Math.abs(dx);
    const d = upright ? dy : dx;
    const step = smooth ? 1.0 : 60.0;
    if (upright) {
      const upper = cv._vUpper() - cv.H;
      const room = d > 0 ? upper - cv.sy : cv.sy;
      // A few pixels of play, as a scrollbar taking its space leaves, is not worth scrolling.
      if (room > 0.5 && upper > 12) {
        cv._setAdj('v', cv.sy + d * step);
        cv._turnHold(smooth);   // reaching the edge mid-swipe must not turn the page too
        return;
      }
    }
    const i = cv.currentPageIndex();
    const page = cv.doc.pages[i];
    const slot = page.w * cv._z(page) + 2 * SIDE;
    if (slot > cv.W + 1) {
      const lo = cv.slots[i], hi = cv.slots[i] + slot - cv.W;
      const room = d > 0 ? hi - cv.sx : cv.sx - lo;
      if (room > 0.5) {
        cv._setAdj('h', clamp(cv.sx + d * step, lo, hi));
        cv._turnHold(smooth);
        return;
      }
    }
    const now = mono();
    const quiet = now - cv.turnAt > 180;
    cv.turnAt = now;
    if (smooth) {
      // A swipe goes on sending movement long after the fingers have left; all of it, up to the next pause, is one turn.
      if (quiet) { cv.turnSum = 0.0; cv.turnDone = false; }
      cv.turnSum += d;
      if (cv.turnDone || Math.abs(cv.turnSum) < 24) return;
      cv.turnDone = true;
    } else {
      if (quiet || cv.turnSum * d < 0) cv.turnSum = 0.0;
      cv.turnSum += d;
      // A wheel may report fractions of a notch, or spin on freely: a whole notch turns a page, and not more often than the eye can follow.
      if (Math.abs(cv.turnSum) < 0.99 || now - cv.turnedAt < 220) return;
      cv.turnSum = 0.0;
      cv.turnedAt = now;
    }
    const j = (cv.anim ? cv.turning : i) + (d > 0 ? 1 : -1);
    if (j >= 0 && j < cv.slots.length) cv.scrollToPage(j);
  },

  /** @param {boolean} smooth */
  _turnHold(smooth) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    if (smooth) { cv.turnAt = mono(); cv.turnDone = true; }
  },
};

Object.assign(PageCanvas.prototype, methods);
export { RULER_W };
