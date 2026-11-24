// Shared helpers for driving the app on a device: adb input + Chrome DevTools.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

export const SDK = process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`;
export const ADB = `${SDK}/platform-tools/adb`;
export const PKG = "com.techbyshubhamsaroj.weatherwise";
const PORT = 9333;
const args = process.argv.slice(2);
export const SHOTS = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
export const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const adb = (...a) => execFileSync(ADB, a, { encoding: "utf8" });
export const sh = (cmd) => adb("shell", cmd);

// ---------------------------------------------------------------------------
// DevTools connection

let ws = null, seq = 0;
const pending = new Map();
export const logs = [];

export async function connect() {
  if (ws) try { ws.close(); } catch { /* ignore */ }
  let pid = "";
  for (let i = 0; i < 40 && !pid; i++) {
    pid = sh(`pidof ${PKG}`).trim();
    if (!pid) await sleep(250);
  }
  if (!pid) throw new Error("app is not running");
  adb("forward", "--remove-all");
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    try {
      adb("forward", `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
      const list = await (await fetch(`http://localhost:${PORT}/json`)).json();
      target = list.find((t) => t.type === "page" && t.url.startsWith("https://localhost"));
    } catch { /* not ready yet */ }
    if (!target) await sleep(300);
  }
  if (!target) throw new Error("WebView DevTools not reachable (is this the debug build?)");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
    if (d.method === "Runtime.exceptionThrown") logs.push(`EXCEPTION ${d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text}`);
    // Capacitor's debug-build bridge logs failed plugin calls itself (e.g. an expected GPS timeout);
    // only errors raised from the app bundle count.
    const fromApp = (st) => (st?.callFrames || []).some((f) => /\/app\.js/.test(f.url));
    if (d.method === "Runtime.consoleAPICalled" && (d.params.type === "error" || d.params.type === "assert") && fromApp(d.params.stackTrace)) {
      logs.push(`console.error ${d.params.args.map((a) => a.value ?? (a.preview ? JSON.stringify(Object.fromEntries(a.preview.properties.map((p) => [p.name, p.value]))) : a.description)).join(" ")}`);
    }
    if (d.method === "Log.entryAdded" && (d.params.entry.level === "error" || /Refused|Content Security/i.test(d.params.entry.text))) logs.push(`log ${d.params.entry.source}: ${d.params.entry.text} ${d.params.entry.url || ""}`);
  };
  await send("Runtime.enable");
  await send("Log.enable");
}

export function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, (d) => { clearTimeout(t); d.error ? reject(new Error(d.error.message)) : resolve(d.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

export async function js(expr) {
  const r = await send("Runtime.evaluate", { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`JS error in: ${expr}\n${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}

export async function waitFor(expr, ms = 15000, what = expr) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await js(expr); if (last) return last; } catch (e) { last = e.message; }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for: ${what} (last: ${JSON.stringify(last)})`);
}

// ---------------------------------------------------------------------------
// Touch input in CSS pixels → device pixels

export async function geometry() {
  const g = await js(`({ dpr: devicePixelRatio, w: innerWidth, h: innerHeight })`);
  const list = await (await fetch(`http://localhost:${PORT}/json`)).json();
  const desc = JSON.parse(list.find((t) => t.type === "page").description || "{}");
  return { ...g, ox: desc.screenX || 0, oy: desc.screenY || 0 };
}
export async function tapXY(x, y) {
  const g = await geometry();
  adb("shell", "input", "tap", String(Math.round(g.ox + x * g.dpr)), String(Math.round(g.oy + y * g.dpr)));
}
export async function center(selector, index = 0) {
  const r = await js(`(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height }; })()`);
  if (!r) throw new Error(`No element: ${selector}[${index}]`);
  return r;
}
export async function tap(selector, index = 0) {
  const c = await center(selector, index);
  await tapXY(c.x, c.y);
}
/** Tap and wait for an outcome; retry (and report it) if a slow device dropped the tap. */
export const retries = [];
export async function tapFor(selector, cond, what, index = 0) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await tap(selector, index);
    try { return await waitFor(cond, attempt === 3 ? 6000 : 2500, what); } catch (e) {
      if (attempt === 3) throw e;
      retries.push(`${what} (attempt ${attempt + 1})`);
    }
  }
}
export async function swipe(x1, y1, x2, y2, ms = 300) {
  const g = await geometry();
  const p = (x, o) => String(Math.round(o + x * g.dpr));
  adb("shell", "input", "swipe", p(x1, g.ox), p(y1, g.oy), p(x2, g.ox), p(y2, g.oy), String(ms));
}
export const back = () => sh("input keyevent 4");
export const typeText = (t) => adb("shell", "input", "text", t.replace(/ /g, "%s"));
export function screenshot(name) {
  if (!SHOTS) return;
  writeFileSync(`${SHOTS}/${name}.png`, execFileSync(ADB, ["exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 }));
}
export async function relaunch({ clear = false } = {}) {
  // Leave the app like a person would (Android flushes pending writes on stop), then kill it.
  sh("input keyevent 3");
  await sleep(1200);
  sh(`am force-stop ${PKG}`);
  if (clear) sh(`pm clear ${PKG}`);
  sh(`am start -W -n ${PKG}/.MainActivity`);
  await sleep(1500);
  await connect();
}
export const noOverflow = () => js(`document.documentElement.scrollWidth <= innerWidth + 1`);

