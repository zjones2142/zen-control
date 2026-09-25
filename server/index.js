#!/usr/bin/env node
/* Zen Control — MCP bridge.
 * Speaks MCP over stdio to Claude Code and hosts a WebSocket server on
 * 127.0.0.1:17373 that the Zen Control extension connects to (/ext).
 * If another bridge already owns the port (another Claude session), this
 * process becomes a client of it (/ctl) and proxies commands through. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";

const PORT = Number(process.env.ZEN_CONTROL_PORT || 17373);
const HOST = "127.0.0.1";
const CMD_TIMEOUT_MS = 45000;
const log = (...a) => console.error("[zen-control]", ...a);

/* ---------- transport to the extension (owner or proxy) ---------- */

let ext = null;          // extension socket (when we own the port)
let upstream = null;     // socket to the owning bridge (when proxying)
let mode = "starting";
const pending = new Map(); // id -> {resolve, reject, timer}
let seq = 0;
const ctlClients = new Set();

function settle(msg) {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || "Unknown error"));
}

function sendCommand(cmd, args, timeout = CMD_TIMEOUT_MS) {
  const target = mode === "owner" ? ext : upstream;
  if (!target || target.readyState !== WebSocket.OPEN) {
    const why = mode === "owner"
      ? "The Zen Control extension is not connected. Make sure Zen is running with the extension installed (toolbar icon should show 'on')."
      : "Not connected to the browser bridge yet; try again in a second.";
    return Promise.reject(new Error(why));
  }
  const id = `${process.pid}-${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out after ${timeout}ms waiting for the browser (${cmd})`)); }, timeout + 1000);
    pending.set(id, { resolve, reject, timer });
    target.send(JSON.stringify({ type: "cmd", id, cmd, args }));
  });
}

function startOwner() {
  const wss = new WebSocketServer({ host: HOST, port: PORT });
  wss.on("listening", () => { mode = "owner"; log(`listening on ws://${HOST}:${PORT}`); });
  wss.on("error", (e) => {
    if (e.code === "EADDRINUSE") { wss.close(); startProxy(); }
    else log("ws server error", e);
  });
  wss.on("connection", (sock, req) => {
    const path = (req.url || "/").split("?")[0];
    if (path === "/ext") {
      if (ext && ext.readyState === WebSocket.OPEN) ext.close();
      ext = sock;
      log("extension connected");
      sock.on("message", (data) => {
        let msg; try { msg = JSON.parse(data); } catch { return; }
        if (msg.type !== "result") return;
        // route: our own request, or one from a ctl client (id prefixed with its pid)
        if (pending.has(msg.id)) return settle(msg);
        for (const c of ctlClients) if (c.ids.has(msg.id)) { c.ids.delete(msg.id); c.sock.send(JSON.stringify(msg)); return; }
      });
      sock.on("close", () => { if (ext === sock) { ext = null; log("extension disconnected"); } for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("Extension disconnected")); } pending.clear(); });
    } else if (path === "/ctl") {
      const c = { sock, ids: new Set() };
      ctlClients.add(c);
      sock.on("message", (data) => {
        let msg; try { msg = JSON.parse(data); } catch { return; }
        if (msg.type !== "cmd") return;
        if (!ext || ext.readyState !== WebSocket.OPEN) return sock.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: "The Zen Control extension is not connected. Make sure Zen is running with the extension installed." }));
        c.ids.add(msg.id);
        ext.send(JSON.stringify(msg));
      });
      sock.on("close", () => ctlClients.delete(c));
    } else {
      sock.close();
    }
  });
}

function startProxy() {
  mode = "proxy";
  const sock = new WebSocket(`ws://${HOST}:${PORT}/ctl`);
  sock.on("open", () => { upstream = sock; log("proxying through existing bridge"); });
  sock.on("message", (data) => { let msg; try { msg = JSON.parse(data); } catch { return; } if (msg.type === "result") settle(msg); });
  const retry = () => {
    if (upstream === sock) upstream = null;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("Bridge connection lost")); }
    pending.clear();
    setTimeout(startOwner, 500); // owner may have exited: try to take over the port
  };
  sock.on("close", retry);
  sock.on("error", () => { /* close follows */ });
}

startOwner();

/* ---------- MCP surface ---------- */

const server = new McpServer({ name: "zen-browser", version: "0.1.0" });

const tabId = z.number().int().optional().describe("Tab id (from tabs_list). Defaults to the tab Claude last used, else the active tab.");
const targetShape = {
  ref: z.string().optional().describe("Element ref from read_page/find, e.g. \"e12\""),
  selector: z.string().optional().describe("CSS selector (alternative to ref)"),
  tabId,
};

function text(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}
function tool(name, description, shape, run) {
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try { return await run(args); }
    catch (e) { return { isError: true, content: [{ type: "text", text: `Error: ${e.message || e}` }] }; }
  });
}

tool("tabs_list", "List open Zen browser tabs (id, url, title) and which tab is current.", {}, async () => text(await sendCommand("tabs_list", {})));
tool("tab_new", "Open a new tab, optionally at a URL, and make it the current tab.", { url: z.string().url().optional(), active: z.boolean().optional().describe("Focus the tab (default true)") }, async (a) => text(await sendCommand("tab_new", a)));
tool("tab_select", "Make a tab current and bring it to the front.", { tabId: z.number().int() }, async (a) => text(await sendCommand("tab_select", a)));
tool("tab_close", "Close a tab (default: the current one).", { tabId }, async (a) => text(await sendCommand("tab_close", a)));
tool("navigate", "Navigate the current tab to a URL and wait for the page to load.", { url: z.string().describe("Absolute URL"), tabId }, async (a) => text(await sendCommand("navigate", a)));
tool("go_back", "Go back in history and wait for load.", { tabId }, async (a) => text(await sendCommand("back", a)));
tool("go_forward", "Go forward in history and wait for load.", { tabId }, async (a) => text(await sendCommand("forward", a)));
tool("reload", "Reload the page and wait for load.", { tabId, bypassCache: z.boolean().optional() }, async (a) => text(await sendCommand("reload", a)));

tool("read_page", "Get a compact outline of the visible page: headings, text, and every interactive element with a ref (e.g. [e7] button \"Sign in\") that click/type/hover accept. Call this before interacting; refs go stale after navigation.",
  { filter: z.enum(["all", "interactive"]).optional().describe("'interactive' omits plain text (default 'all')"), maxChars: z.number().int().optional().describe("Truncate output (default 20000)"), tabId },
  async (a) => { const r = await sendCommand("read_page", a); return text(`${r.title}\n${r.url}\n${r.elements} elements${r.truncated ? " (truncated)" : ""}\n\n${r.content}`); });
tool("find", "Search visible interactive elements/headings/images whose name, href, placeholder, id, or label contains the query (case-insensitive). Returns refs.",
  { query: z.string(), limit: z.number().int().optional(), tabId }, async (a) => { const r = await sendCommand("find", a); return text(r.count ? r.content : `No elements matched "${a.query}"`); });
tool("get_text", "Get the page's visible text (innerText), optionally scoped to a CSS selector.", { selector: z.string().optional(), maxChars: z.number().int().optional().describe("default 30000"), tabId },
  async (a) => { const r = await sendCommand("get_text", a); return text(`${r.title}\n${r.url}\n\n${r.text}`); });

tool("click", "Click an element by ref, selector, or viewport coordinates (CSS px, matching screenshot coordinates). Waits for navigation if one starts.",
  { ...targetShape, x: z.number().optional(), y: z.number().optional(), double: z.boolean().optional() }, async (a) => text(await sendCommand("click", a)));
tool("hover", "Hover over an element (fires mouseover/mouseenter) to reveal menus or tooltips.", targetShape, async (a) => text(await sendCommand("hover", a)));
tool("type", "Type text into an input, textarea, or contenteditable (by ref/selector, or the focused element). Clears existing content unless clear=false. submit=true presses Enter afterwards.",
  { text: z.string(), ...targetShape, clear: z.boolean().optional(), submit: z.boolean().optional() }, async (a) => text(await sendCommand("type", a)));
tool("press_key", "Press a key on the focused element (or ref/selector). Examples: Enter, Escape, Tab, ArrowDown, Backspace, ctrl+a, shift+Tab.",
  { key: z.string(), ...targetShape }, async (a) => text(await sendCommand("press_key", a)));
tool("select_option", "Choose an option in a <select> by value or visible label.", { value: z.string(), ...targetShape }, async (a) => text(await sendCommand("select_option", a)));
tool("scroll", "Scroll the page by direction (up/down/left/right/top/bottom, default down ~80% of viewport) or scroll an element (ref/selector) into view.",
  { direction: z.enum(["up", "down", "left", "right", "top", "bottom"]).optional(), amount: z.number().optional().describe("pixels"), ...targetShape }, async (a) => text(await sendCommand("scroll", a)));
tool("wait_for", "Wait until a CSS selector exists or text appears on the page (or just sleep if neither given). timeout in ms (default 10000).",
  { selector: z.string().optional(), text: z.string().optional(), timeout: z.number().int().optional(), tabId }, async (a) => text(await sendCommand("wait_for", a, (a.timeout || 10000) + 2000)));

tool("screenshot", "Capture the visible viewport of the current tab as a PNG (scaled to CSS pixels so click x/y match).", { tabId }, async (a) => {
  const r = await sendCommand("screenshot", a);
  const b64 = r.dataUrl.replace(/^data:image\/png;base64,/, "");
  return { content: [{ type: "text", text: `Viewport ${r.viewportWidth}x${r.viewportHeight} CSS px; image ${r.width}x${r.height}${r.scale < 1 ? ` (scaled ${r.scale.toFixed(2)}; divide image coords by scale for click)` : ""}` }, { type: "image", data: b64, mimeType: "image/png" }] };
});
tool("evaluate", "Run JavaScript in the page (async function body; use `return` for a result, which is JSON-serialized). Runs in the extension's content-script sandbox with full DOM access; the page's own JS globals are reachable via window.wrappedJSObject.",
  { code: z.string(), tabId }, async (a) => text((await sendCommand("evaluate", a)).result));
tool("console_logs", "Read console output and uncaught errors captured on the current page since it loaded.",
  { level: z.enum(["log", "info", "warn", "error", "debug"]).optional(), limit: z.number().int().optional(), clear: z.boolean().optional(), tabId },
  async (a) => { const r = await sendCommand("console_logs", a); return text(r.count ? r.logs.map((l) => `[${new Date(l.t).toISOString().slice(11, 19)}] ${l.level}: ${l.text}`).join("\n") : "No console output captured."); });
tool("browser_status", "Check whether the Zen Control extension is connected to this bridge.", {}, async () => {
  try { const r = await sendCommand("ping", {}, 3000); return text({ connected: true, mode, currentTabId: r.currentTabId }); }
  catch (e) { return text({ connected: false, mode, error: e.message }); }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log("MCP server ready");
