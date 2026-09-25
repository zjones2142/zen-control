/* Zen Control — content script. Handles DOM-level commands from background.js. */
(() => {
  if (window.__zenControlLoaded) return;
  window.__zenControlLoaded = true;

  /* ---------- console / error capture ---------- */
  const logs = [];
  const MAX_LOGS = 500;
  function pushLog(level, args) {
    const text = args.map((a) => {
      try {
        if (typeof a === "string") return a;
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        return JSON.stringify(a);
      } catch { return String(a); }
    }).join(" ");
    logs.push({ t: Date.now(), level, text: text.slice(0, 2000) });
    if (logs.length > MAX_LOGS) logs.shift();
  }
  try {
    const pageConsole = window.wrappedJSObject.console;
    for (const level of ["log", "info", "warn", "error", "debug"]) {
      const orig = pageConsole[level];
      pageConsole[level] = exportFunction(function (...args) {
        try { pushLog(level, args); } catch {}
        // `args` lives in the content-script compartment. Calling
        // `orig.apply(this, args)` makes the *page's* native `apply` read
        // `args.length` across the privilege boundary, which Firefox rejects
        // with `Permission denied to access property "length"` — thrown into
        // page code on every console call (crashes apps that log at boot,
        // e.g. Apify Console). Reflect.apply runs on our side, so the array is
        // read here and only the individual arguments cross into the page.
        return Reflect.apply(orig, this, args);
      }, window);
    }
  } catch { /* fine — fall back to error events only */ }
  window.addEventListener("error", (e) => pushLog("error", [`${e.message} (${e.filename}:${e.lineno})`]), true);
  window.addEventListener("unhandledrejection", (e) => pushLog("error", ["Unhandled rejection: " + (e.reason && e.reason.message || e.reason)]), true);

  /* ---------- element refs ---------- */
  let refs = new Map();
  let refSeq = 0;
  const elToRef = new WeakMap();
  function refFor(el) {
    let r = elToRef.get(el);
    if (!r) { r = "e" + (++refSeq); elToRef.set(el, r); refs.set(r, el); }
    return r;
  }
  function resolveTarget(args) {
    let el = null;
    if (args.ref) {
      el = refs.get(args.ref);
      if (!el) throw new Error(`Unknown ref "${args.ref}". Call read_page or find to get fresh refs.`);
      if (!el.isConnected) throw new Error(`Element ${args.ref} is no longer in the document. Call read_page again.`);
    } else if (args.selector) {
      el = document.querySelector(args.selector);
      if (!el) throw new Error(`No element matches selector "${args.selector}"`);
    } else if (typeof args.x === "number" && typeof args.y === "number") {
      el = document.elementFromPoint(args.x, args.y);
      if (!el) throw new Error(`No element at (${args.x}, ${args.y})`);
    }
    return el;
  }

  /* ---------- page reading ---------- */
  const INTERACTIVE = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=slider],[contenteditable=''],[contenteditable=true],[onclick],[tabindex]:not([tabindex=\"-1\"])";

  function isVisible(el) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    if (!window.innerWidth || !window.innerHeight) return true; // unrendered viewport (background/headless tab): trust CSS only
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function clean(s, max = 120) {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }
  function roleOf(el) {
    const tag = el.tagName.toLowerCase();
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "checkbox" || t === "radio") return t;
      if (t === "hidden") return null;
      return "textbox";
    }
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (el.isContentEditable) return "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "img") return "image";
    if (tag === "summary") return "button";
    if (el.hasAttribute("onclick") || (el.hasAttribute("tabindex") && el.tabIndex >= 0)) return "clickable";
    return null;
  }
  function labelText(el) {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return l.innerText;
    }
    const wrap = el.closest("label");
    return wrap ? wrap.innerText : "";
  }
  function nameOf(el, role) {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const lab = el.getAttribute("aria-labelledby");
    if (lab) { const t = lab.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" "); if (t.trim()) return clean(t); }
    if (role === "image") return clean(el.getAttribute("alt") || el.getAttribute("title") || "");
    if (["textbox", "combobox", "checkbox", "radio"].includes(role)) {
      return clean(labelText(el) || el.getAttribute("placeholder") || el.getAttribute("name") || el.getAttribute("title") || "");
    }
    const inner = el.innerText || el.textContent || "";
    if (inner.trim()) return clean(inner);
    const img = el.querySelector("img[alt]");
    if (img) return clean(img.getAttribute("alt"));
    return clean(el.getAttribute("title") || el.getAttribute("value") || "");
  }
  function describe(el) {
    const role = roleOf(el);
    if (!role) return null;
    const parts = [`[${refFor(el)}] ${role}`];
    if (role === "heading") parts[0] += el.tagName[1];
    const name = nameOf(el, role);
    if (name) parts.push(JSON.stringify(name));
    if (role === "link") { const h = el.getAttribute("href"); if (h && !h.startsWith("javascript:")) parts.push("href=" + clean(h, 100)); }
    if (role === "textbox" || role === "combobox") {
      const v = el.value != null ? el.value : el.innerText;
      if (v) parts.push("value=" + JSON.stringify(clean(v, 60)));
      if (el.type && el.tagName === "INPUT" && el.type !== "text") parts.push("type=" + el.type);
    }
    if (role === "combobox" && el.tagName === "SELECT") {
      const opts = [...el.options].slice(0, 20).map((o) => o.textContent.trim());
      parts.push("options=" + JSON.stringify(opts));
    }
    if (role === "checkbox" || role === "radio" || role === "switch") {
      const checked = el.checked != null ? el.checked : el.getAttribute("aria-checked") === "true";
      parts.push(checked ? "checked" : "unchecked");
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
    if (el.getAttribute("aria-expanded")) parts.push("expanded=" + el.getAttribute("aria-expanded"));
    return parts.join(" ");
  }

  function readPage(args) {
    refs = new Map();
    const interactiveOnly = args.filter === "interactive";
    const maxChars = args.maxChars || 20000;
    const lines = [];
    const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "HEAD", "META", "LINK"]);
    function walk(node, depth) {
      if (node.nodeType !== 1 || SKIP.has(node.tagName)) return;
      if (!isVisible(node)) return;
      const indent = "  ".repeat(Math.min(depth, 8));
      const role = roleOf(node);
      if (role) {
        const d = describe(node);
        if (d) lines.push(indent + d);
        if (role === "link" || role === "button" || role === "textbox" || role === "image" || role === "heading") return;
      }
      if (!interactiveOnly) {
        const own = [...node.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(" ");
        const t = clean(own, 400);
        if (t) lines.push(indent + "text " + JSON.stringify(t));
      }
      let childDepth = depth + (role ? 1 : 0);
      for (const c of node.children) walk(c, childDepth);
      if (node.shadowRoot) for (const c of node.shadowRoot.children) walk(c, childDepth);
    }
    walk(document.body || document.documentElement, 0);
    let out = lines.join("\n");
    let truncated = false;
    if (out.length > maxChars) { out = out.slice(0, maxChars) + "\n…[truncated]"; truncated = true; }
    return { url: location.href, title: document.title, elements: refs.size, truncated, content: out };
  }

  function find(args) {
    const q = (args.query || "").toLowerCase();
    if (!q) throw new Error("query is required");
    const scored = [];
    for (const el of document.querySelectorAll(INTERACTIVE + ",h1,h2,h3,h4,h5,h6,img,label")) {
      if (!isVisible(el)) continue;
      const role = roleOf(el);
      if (!role) continue;
      const name = nameOf(el, role).toLowerCase();
      const attrs = [el.getAttribute("placeholder"), el.getAttribute("name"), el.id, el.getAttribute("title"), el.getAttribute("aria-label")].filter(Boolean).join(" ").toLowerCase();
      const href = (el.getAttribute("href") || "").toLowerCase();
      let score = 0;
      if (name === q) score += 4;
      if (name.includes(q)) score += 2;
      if (attrs.includes(q)) score += 2;
      if (href.includes(q)) score += 1;
      if (!score) continue;
      if (["textbox", "combobox", "button", "checkbox", "radio"].includes(role)) score += 1;
      scored.push({ score, el });
    }
    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, args.limit || 20).map((s) => describe(s.el));
    return { count: results.length, total: scored.length, content: results.join("\n") };
  }

  /* ---------- actions ---------- */
  function center(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  function mouseSeq(el, x, y, types, extra = {}) {
    for (const type of types) {
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type.includes("down") ? 1 : 0, pointerId: 1, pointerType: "mouse", isPrimary: true, view: window, ...extra }));
    }
  }
  function click(args) {
    let el = resolveTarget(args);
    if (!el) throw new Error("click needs ref, selector, or x/y");
    if (!(typeof args.x === "number")) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const { x, y } = typeof args.x === "number" ? { x: args.x, y: args.y } : center(el);
    const topEl = document.elementFromPoint(x, y) || el;
    const target = topEl.contains(el) || el.contains(topEl) ? topEl : el;
    mouseSeq(target, x, y, ["pointerover", "mouseover", "pointermove", "mousemove", "pointerdown", "mousedown"]);
    if (target.focus) target.focus({ preventScroll: true });
    mouseSeq(target, x, y, ["pointerup", "mouseup"]);
    const detail = args.double ? 2 : 1;
    mouseSeq(target, x, y, ["click"], { detail });
    if (args.double) mouseSeq(target, x, y, ["dblclick"], { detail: 2 });
    return { clicked: describe(el) || el.tagName.toLowerCase(), mayNavigate: true };
  }
  function hover(args) {
    const el = resolveTarget(args);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const { x, y } = center(el);
    mouseSeq(el, x, y, ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]);
    return { hovered: describe(el) || el.tagName.toLowerCase() };
  }

  const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32 };
  function keyEvent(el, type, key, mods = {}) {
    const code = key.length === 1 ? (/[a-z]/i.test(key) ? "Key" + key.toUpperCase() : /[0-9]/.test(key) ? "Digit" + key : "") : key === " " ? "Space" : key;
    const ev = new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true, composed: true, keyCode: KEY_CODES[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0), which: KEY_CODES[key] || 0, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta, view: window });
    return el.dispatchEvent(ev);
  }
  function setNativeValue(el, value) {
    el.value = value; // content-script world sees the native setter (page overrides are hidden by Xrays)
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  }
  function type(args) {
    const el = args.ref || args.selector ? resolveTarget(args) : document.activeElement;
    if (!el || el === document.body) throw new Error("No focused element; pass ref or selector");
    const text = String(args.text ?? "");
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.focus();
    const isField = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
    if (isField) {
      if (args.clear !== false) setNativeValue(el, "");
      if (el.tagName === "INPUT" && ["email", "number", "date", "time", "color", "range"].includes(el.type)) {
        setNativeValue(el, text);
      } else {
        for (const ch of text) {
          const key = ch === "\n" ? "Enter" : ch;
          if (!keyEvent(el, "keydown", key)) { keyEvent(el, "keyup", key); continue; }
          keyEvent(el, "keypress", key);
          if (el.tagName === "TEXTAREA" || ch !== "\n") {
            const start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? el.value.length;
            setNativeValue(el, el.value.slice(0, start) + ch + el.value.slice(end));
            try { el.setSelectionRange(start + 1, start + 1); } catch {}
          }
          keyEvent(el, "keyup", key);
        }
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      if (args.clear !== false) { document.execCommand("selectAll", false); document.execCommand("delete", false); }
      document.execCommand("insertText", false, text);
    } else {
      throw new Error(`Element ${describe(el) || el.tagName} is not editable`);
    }
    let submitted = false;
    if (args.submit) submitted = pressEnter(el);
    const out = { typed: text.length, into: describe(el) || el.tagName.toLowerCase(), submitted, mayNavigate: !!args.submit };
    // Surface form validation: apps often reject a value silently (React/Formik
    // render the error below the fold and just refuse to submit), so report it.
    const validation = validationFor(el);
    if (validation) out.validation = validation;
    return out;
  }
  /* Collects native constraint errors, aria-invalid, and nearby error text for a field. */
  function validationFor(el) {
    const problems = [];
    try { if (el.willValidate && !el.checkValidity()) problems.push(el.validationMessage || "fails native constraint validation"); } catch {}
    if (el.getAttribute("aria-invalid") === "true") problems.push("aria-invalid=true");
    const ids = ((el.getAttribute("aria-errormessage") || "") + " " + (el.getAttribute("aria-describedby") || "")).trim().split(/\s+/).filter(Boolean);
    for (const id of ids) { const n = document.getElementById(id); const t = n && clean(n.innerText, 200); if (t) problems.push(t); }
    // Blur so on-blur validators run, then look for an error node near the field.
    el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    let n = el;
    for (let depth = 0; depth < 4 && n; depth++, n = n.parentElement) {
      const errNode = [...n.querySelectorAll('[role=alert], [aria-live=assertive], [class*="error" i], [class*="invalid" i], [class*="helper" i]')].find((x) => x !== el && isVisible(x) && clean(x.innerText));
      if (errNode) { const t = clean(errNode.innerText, 200); if (t && !problems.includes(t)) problems.push(t); break; }
    }
    return problems.length ? problems.join(" | ") : null;
  }
  function pressEnter(el) {
    const notPrevented = keyEvent(el, "keydown", "Enter");
    keyEvent(el, "keypress", "Enter");
    keyEvent(el, "keyup", "Enter");
    if (notPrevented && el.form && el.tagName === "INPUT") {
      if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit();
      return true;
    }
    return false;
  }
  function pressKey(args) {
    const el = args.ref || args.selector ? resolveTarget(args) : document.activeElement || document.body;
    const combo = String(args.key || "");
    const parts = combo.split("+");
    const key = parts.pop();
    const mods = { ctrl: parts.some((p) => /^(ctrl|control)$/i.test(p)), shift: parts.some((p) => /^shift$/i.test(p)), alt: parts.some((p) => /^alt$/i.test(p)), meta: parts.some((p) => /^(meta|cmd|super)$/i.test(p)) };
    if (!key) throw new Error("key is required (e.g. Enter, Escape, Tab, ArrowDown, ctrl+a)");
    let submitted = false;
    if (key === "Enter" && !parts.length) submitted = pressEnter(el);
    else {
      const ok = keyEvent(el, "keydown", key, mods);
      keyEvent(el, "keypress", key, mods);
      if (ok && key.length === 1 && !mods.ctrl && !mods.meta && !mods.alt && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) setNativeValue(el, el.value + key);
      keyEvent(el, "keyup", key, mods);
    }
    return { pressed: combo, on: describe(el) || el.tagName.toLowerCase(), submitted, mayNavigate: key === "Enter" };
  }
  function scroll(args) {
    if (args.ref || args.selector) {
      const el = resolveTarget(args);
      el.scrollIntoView({ block: args.block || "center", behavior: "instant" });
    } else {
      const amount = args.amount ?? Math.round(window.innerHeight * 0.8);
      const dx = args.direction === "right" ? amount : args.direction === "left" ? -amount : 0;
      const dy = args.direction === "up" ? -amount : args.direction === "left" || args.direction === "right" ? 0 : amount;
      if (args.direction === "top") window.scrollTo(0, 0);
      else if (args.direction === "bottom") window.scrollTo(0, document.documentElement.scrollHeight);
      else window.scrollBy({ left: dx, top: dy, behavior: "instant" });
    }
    return { scrollX: window.scrollX, scrollY: window.scrollY, pageHeight: document.documentElement.scrollHeight, viewportHeight: window.innerHeight };
  }
  function selectOption(args) {
    const el = resolveTarget(args);
    if (el.tagName !== "SELECT") throw new Error("select_option target must be a <select>");
    const want = String(args.value ?? "");
    const opt = [...el.options].find((o) => o.value === want) || [...el.options].find((o) => o.textContent.trim().toLowerCase() === want.toLowerCase());
    if (!opt) throw new Error(`No option "${want}". Options: ${[...el.options].map((o) => o.textContent.trim()).join(", ")}`);
    el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { selected: opt.textContent.trim(), value: opt.value };
  }
  function getText(args) {
    const root = args.selector ? document.querySelector(args.selector) : document.body;
    if (!root) throw new Error(`No element matches "${args.selector}"`);
    const max = args.maxChars || 30000;
    let t = (root.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    const truncated = t.length > max;
    if (truncated) t = t.slice(0, max) + "\n…[truncated]";
    return { url: location.href, title: document.title, truncated, text: t };
  }
  async function waitFor(args) {
    const timeout = args.timeout || 10000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (args.selector && document.querySelector(args.selector)) return { found: "selector", elapsed: Date.now() - start };
      if (args.text && (document.body?.innerText || "").includes(args.text)) return { found: "text", elapsed: Date.now() - start };
      if (!args.selector && !args.text) { await new Promise((r) => setTimeout(r, timeout)); return { waited: timeout }; }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out after ${timeout}ms waiting for ${args.selector ? `selector "${args.selector}"` : `text "${args.text}"`}`);
  }
  async function evaluate(args) {
    // Async function body with `return` support. Runs in the content-script sandbox:
    // full DOM access; page globals are reachable through window.wrappedJSObject.
    const fn = new Function("return (async () => {" + args.code + "\n})()");
    let v = await fn();
    if (v && typeof v === "object" && v.wrappedJSObject) v = v.wrappedJSObject;
    let json;
    try { json = JSON.parse(JSON.stringify(v === undefined ? null : v)); } catch { json = String(v); }
    return { result: json };
  }
  function consoleLogs(args) {
    let out = logs.slice();
    if (args.level) out = out.filter((l) => l.level === args.level);
    if (args.clear) logs.length = 0;
    return { count: out.length, logs: out.slice(-(args.limit || 100)) };
  }

  const handlers = { ping: () => ({ pong: true, url: location.href }), read_page: readPage, find, click, hover, type, press_key: pressKey, scroll, select_option: selectOption, get_text: getText, wait_for: waitFor, evaluate, console_logs: consoleLogs };

  browser.runtime.onMessage.addListener((msg) => {
    const h = handlers[msg && msg.cmd];
    if (!h) return Promise.resolve({ __error: "Unknown command: " + (msg && msg.cmd) });
    return Promise.resolve().then(() => h(msg.args || {})).catch((e) => ({ __error: String(e && e.message || e) }));
  });
})();
