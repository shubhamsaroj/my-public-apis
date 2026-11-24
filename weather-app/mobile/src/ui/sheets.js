// Bottom sheets + toast + haptics.
//
// The sheet stack is the single owner of the background scroll lock
// (html.sheet-open). The lock is released whenever the stack becomes empty.

import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { $ } from "../lib/dom.js";

const native = Capacitor.isNativePlatform();
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function tap() {
  if (native) Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
}
export function tick() {
  if (native) Haptics.selectionChanged().catch(() => {});
}

// ---------------------------------------------------------------------------
const stack = [];
const listeners = new Set();
const lastFocus = new Map();

export const onSheetsChange = (fn) => listeners.add(fn);
export const anySheetOpen = () => stack.length > 0;
export const isSheetOpen = (id) => stack.includes(id);
export const topSheet = () => stack[stack.length - 1] || null;

function sync() {
  const top = topSheet();
  document.documentElement.classList.toggle("sheet-open", stack.length > 0);
  // Only the top sheet is reachable by touch, keyboard and screen readers.
  for (const id of ["app", "topbar"]) $(id).inert = stack.length > 0;
  document.querySelectorAll(".sheet-wrap").forEach((w) => { w.inert = w.id !== top; });
  for (const fn of listeners) fn(stack.length);
}

/** Screen readers are only shown the dialog that holds the focus, so it always moves with the top sheet. */
function focusSheet(id) {
  const title = $($(id).getAttribute("aria-labelledby"));
  if (!title) return;
  title.tabIndex = -1;
  title.focus({ preventScroll: true });
}

export function openSheet(id, { focus = null } = {}) {
  const wrap = $(id);
  if (!wrap || stack.includes(id)) return;
  clearTimeout(wrap._hideTimer);
  lastFocus.set(id, document.activeElement);
  wrap.classList.remove("hidden");
  const sheet = wrap.querySelector(".sheet");
  sheet.style.transform = "";
  const body = wrap.querySelector(".sheet-body");
  if (body) body.scrollTop = 0;
  void wrap.offsetWidth; // commit the start state so the transition runs
  wrap.classList.add("open");
  stack.push(id);
  sync();
  focusSheet(id);
  if (focus) setTimeout(() => focus.focus({ preventScroll: true }), reduced() ? 0 : 260);
}

export function closeSheet(id) {
  const i = stack.indexOf(id);
  if (i < 0) return;
  stack.splice(i, 1);
  const wrap = $(id);
  wrap.classList.remove("open");
  const active = document.activeElement;
  if (active && wrap.contains(active)) active.blur();
  wrap._hideTimer = setTimeout(() => wrap.classList.add("hidden"), reduced() ? 0 : 300);
  sync();
  const prev = lastFocus.get(id);
  if (prev && prev !== document.body && document.contains(prev) && !wrap.contains(prev)) prev.focus?.({ preventScroll: true });
  else if (topSheet()) focusSheet(topSheet());
}

export function closeTop() {
  const id = topSheet();
  if (!id) return false;
  closeSheet(id);
  return true;
}

export function closeAll() {
  [...stack].reverse().forEach(closeSheet);
}

/** Wire backdrop taps, close buttons and drag-to-dismiss for every sheet in the page. */
export function initSheets() {
  document.querySelectorAll(".sheet-wrap").forEach((wrap) => {
    const id = wrap.id;
    wrap.querySelector(".sheet-backdrop")?.addEventListener("click", () => closeSheet(id));
    wrap.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) closeSheet(id);
    });

    // Drag-to-dismiss lives on the handle/header only. We own that gesture completely
    // (preventDefault on touchmove), so Chrome never starts a native fling from it —
    // otherwise a quick flick makes Chrome swallow the user's next tap as a "fling stop".
    // Sheet content keeps native, fully passive scrolling.
    const sheet = wrap.querySelector(".sheet");
    let y0 = null, dy = 0, t0 = 0;
    const start = (e) => {
      if (e.touches.length !== 1 || e.target.closest("input,button")) return;
      y0 = e.touches[0].clientY;
      dy = 0;
      t0 = performance.now();
      sheet.classList.add("dragging");
    };
    const move = (e) => {
      if (y0 == null) return;
      if (e.cancelable) e.preventDefault();
      dy = Math.max(0, e.touches[0].clientY - y0);
      sheet.style.transform = dy ? `translate3d(0,${dy}px,0)` : "";
    };
    const end = () => {
      if (y0 == null) return;
      sheet.classList.remove("dragging");
      const fast = dy > 40 && dy / Math.max(1, performance.now() - t0) > 0.6;
      sheet.style.transform = "";
      if (dy > 110 || fast) closeSheet(id);
      y0 = null;
    };
    wrap.querySelectorAll("[data-drag]").forEach((zone) => {
      zone.addEventListener("touchstart", start, { passive: true });
      zone.addEventListener("touchmove", move, { passive: false });
      zone.addEventListener("touchend", end);
      zone.addEventListener("touchcancel", end);
    });
  });
}

// ---------------------------------------------------------------------------
let toastTimer = 0;
export function toast(message, { ms = 3200, action = null, onAction = null } = {}) {
  const t = $("toast");
  t.replaceChildren();
  const text = document.createElement("span");
  text.textContent = message;
  t.appendChild(text);
  if (action && onAction) {
    const b = document.createElement("button");
    b.className = "toast-action";
    b.type = "button";
    b.textContent = action;
    b.addEventListener("click", () => { hideToast(); onAction(); });
    t.appendChild(b);
  }
  t.classList.remove("hidden");
  void t.offsetWidth;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() {
  const t = $("toast");
  t.classList.remove("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 300);
}
