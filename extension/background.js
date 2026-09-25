/* Zen Control — background script.
 * Keeps a WebSocket open to the local MCP bridge and executes commands:
 * tab management + navigation + screenshots here, DOM work in content.js. */

const WS_URL = "ws://127.0.0.1:17373/ext";
const PAGE_LOAD_TIMEOUT_MS = 20000;
const MAX_SHOT_SIDE = 1568;

let ws = null;
let backoff = 1000;
let currentTabId = null;

/* ---------- connection ---------- */

function setBadge(connected) {
  browser.browserAction.setBadgeText({ text: connected ? "on" : "" });
  browser.browserAction.setBadgeBackgroundColor({ color: connected ? "#16a34a" : "#6b7280" });
  browser.browserAction.setTitle({ title: `Zen Control: ${connected ? "connected" : "disconnected"}` });
}

function connect() {
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    backoff = 1000;
    setBadge(true);
    ws.send(JSON.stringify({ type: "hello", ua: navigator.userAgent }));
  };
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || msg.type !== "cmd") return;
    let reply;
    try {
      const result = await handle(msg.cmd, msg.args || {});
      reply = { type: "result", id: msg.id, ok: true, result };
    } catch (e) {
      reply = { type: "result", id: msg.id, ok: false, error: String(e && e.message || e) };
    }
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
  };
  ws.onclose = () => { setBadge(false); scheduleReconnect(); };
  ws.onerror = () => { /* onclose follows */ };
}

function scheduleReconnect() {
  ws = null;
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 10000);
}

/* ---------- helpers ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolveTab(tabId) {
  if (tabId != null) {
    const t = await browser.tabs.get(tabId);
    currentTabId = t.id;
    return t;
  }
  if (currentTabId != null) {
    try { return await browser.tabs.get(currentTabId); } catch { currentTabId = null; }
  }
  const [active] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) throw new Error("No active tab found");
  currentTabId = active.id;
  return active;
}

function tabInfo(t) {
  return { id: t.id, windowId: t.windowId, active: t.active, url: t.url, title: t.title, status: t.status };
}


function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms))]);
}

/* Run `trigger` (which starts a navigation) and resolve once the tab has gone
 * through loading -> complete. If no load ever starts (e.g. same-URL no-op),
 * resolve after a short grace period. */
async function withLoad(tabId, trigger, timeout = PAGE_LOAD_TIMEOUT_MS) {
  let sawLoading = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const onUpdated = (id, info) => {
    if (id !== tabId) return;
    if (info.status === "loading") sawLoading = true;
    if (info.status === "complete" && sawLoading) resolveDone();
  };
  const onRemoved = (id) => { if (id === tabId) resolveDone(); };
  browser.tabs.onUpdated.addListener(onUpdated);
  browser.tabs.onRemoved.addListener(onRemoved);
  try {
    const t0 = Date.now();
    const result = await trigger();
    // grace period: if nothing started loading, don't wait the full timeout
    const grace = new Promise((r) => setTimeout(async () => {
      if (sawLoading) return;
      try { const t = await browser.tabs.get(tabId); if (t.status === "complete") r(); else sawLoading = true; } catch { r(); }
    }, 1500));
    await Promise.race([done, grace, sleep(timeout - (Date.now() - t0))]);
    await sleep(150); // let the page settle
    return result;
  } finally {
    browser.tabs.onUpdated.removeListener(onUpdated);
    browser.tabs.onRemoved.removeListener(onRemoved);
  }
}

async function sendToContent(tab, cmd, args) {
  const msg = { cmd, args };
  let r;
  try {
    r = await browser.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    // content script missing (tab predates extension load, or page still loading) — inject and retry
    try {
      await browser.tabs.executeScript(tab.id, { file: "content.js", runAt: "document_idle" });
    } catch (e2) {
      const t = await browser.tabs.get(tab.id).catch(() => tab);
      throw new Error(`Cannot run page commands on ${t.url || "this tab"} (privileged or unscriptable page: ${e2.message}). Navigate to an http(s) URL first.`);
    }
    await sleep(100);
    r = await browser.tabs.sendMessage(tab.id, msg);
  }
  if (r && r.__error) throw new Error(r.__error);
  return r;
}

async function screenshot(tab) {
  if (!tab.active) {
    await browser.tabs.update(tab.id, { active: true });
    await sleep(300);
  }
  let dataUrl;
  try {
    // Firefox-specific: captures a specific tab, works even when it isn't focused.
    dataUrl = await withTimeout(browser.tabs.captureTab(tab.id, { format: "png" }), 10000, "captureTab");
  } catch (e) {
    try {
      dataUrl = await withTimeout(browser.tabs.captureVisibleTab(tab.windowId, { format: "png" }), 10000, "captureVisibleTab");
    } catch (e2) {
      throw new Error(`Screenshot failed: captureTab: ${e.message}; captureVisibleTab: ${e2.message}`);
    }
  }
  // Scale the capture to CSS pixels so coordinates match what click(x, y) expects.
  let dpr = 1, cssW = null, cssH = null;
  try {
    const [m] = await withTimeout(browser.tabs.executeScript(tab.id, { code: "({dpr: window.devicePixelRatio, w: window.innerWidth, h: window.innerHeight})" }), 3000, "viewport probe");
    dpr = m.dpr || 1; cssW = m.w; cssH = m.h;
  } catch { /* privileged page: keep raw */ }
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await withTimeout(createImageBitmap(blob), 10000, "decode");
  let w = cssW || Math.round(bmp.width / dpr);
  let h = cssH || Math.round(bmp.height / dpr);
  const scale = Math.min(1, MAX_SHOT_SIDE / Math.max(w, h));
  const outW = Math.round(w * scale), outH = Math.round(h * scale);
  const canvas = document.createElement("canvas");
  canvas.width = outW; canvas.height = outH;
  canvas.getContext("2d").drawImage(bmp, 0, 0, outW, outH);
  bmp.close();
  const out = canvas.toDataURL("image/png");
  return { dataUrl: out, width: outW, height: outH, viewportWidth: w, viewportHeight: h, scale, raw: { width: bmp.width, height: bmp.height } };
}

/* ---------- command dispatch ---------- */

async function handle(cmd, args) {
  switch (cmd) {
    case "ping":
      return { pong: true, currentTabId };

    case "tabs_list": {
      const tabs = await browser.tabs.query({});
      return { currentTabId, tabs: tabs.map(tabInfo) };
    }
    case "tab_new": {
      const t = await browser.tabs.create({ url: args.url || "about:blank", active: args.active !== false });
      currentTabId = t.id;
      if (args.url) await withLoad(t.id, async () => {}, args.timeout);
      return tabInfo(await browser.tabs.get(t.id));
    }
    case "tab_select": {
      const t = await browser.tabs.get(args.tabId);
      currentTabId = t.id;
      await browser.tabs.update(t.id, { active: true });
      await browser.windows.update(t.windowId, { focused: true }).catch(() => {});
      return tabInfo(await browser.tabs.get(t.id));
    }
    case "tab_close": {
      const t = await resolveTab(args.tabId);
      await browser.tabs.remove(t.id);
      if (currentTabId === t.id) currentTabId = null;
      return { closed: t.id };
    }
    case "navigate": {
      const t = await resolveTab(args.tabId);
      await withLoad(t.id, () => browser.tabs.update(t.id, { url: args.url }), args.timeout);
      return tabInfo(await browser.tabs.get(t.id));
    }
    case "back":
    case "forward":
    case "reload": {
      const t = await resolveTab(args.tabId);
      await withLoad(t.id, () => cmd === "back" ? browser.tabs.goBack(t.id) : cmd === "forward" ? browser.tabs.goForward(t.id) : browser.tabs.reload(t.id, { bypassCache: !!args.bypassCache }), args.timeout);
      return tabInfo(await browser.tabs.get(t.id));
    }
    case "screenshot": {
      const t = await resolveTab(args.tabId);
      return await screenshot(t);
    }
    case "evaluate": {
      // Runs in the content-script sandbox (full DOM access, page-world variables via window.wrappedJSObject).
      const t = await resolveTab(args.tabId);
      return await sendToContent(t, "evaluate", args);
    }
    default: {
      // Everything else is a DOM command handled by content.js; wait for the
      // page after actions that commonly navigate.
      const t = await resolveTab(args.tabId);
      const r = await sendToContent(t, cmd, args);
      if (["click", "press_key", "type"].includes(cmd) && r && r.mayNavigate) {
        await withLoad(t.id, async () => {}, 8000);
        r.tab = tabInfo(await browser.tabs.get(t.id));
      }
      return r;
    }
  }
}

browser.tabs.onRemoved.addListener((id) => { if (id === currentTabId) currentTabId = null; });
setBadge(false);
connect();
