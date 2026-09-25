# Zen Control

Lets Claude Code drive the Zen browser (Firefox-based) on Linux, in the spirit
of the Claude in Chrome extension.

```
Claude Code  ──stdio (MCP)──►  server/index.js  ◄──ws://127.0.0.1:17373/ext──  Zen Control extension
```

- `extension/` — WebExtension (MV2). `background.js` keeps a WebSocket to the
  bridge and handles tabs/navigation/screenshots; `content.js` handles DOM work
  (read_page, click, type, …) and captures console output.
- `server/index.js` — MCP server registered with Claude Code as `zen-browser`.
  It hosts the WebSocket the extension connects to. If a second Claude session
  starts another copy, that copy proxies through the first one.
- `build-xpi.mjs` — packs `extension/` into `zen-control.xpi`.

## Install / update the extension

Zen (1.14) is built without `MOZ_REQUIRE_SIGNING`, but its default prefs still set
`xpinstall.signatures.required=true`, so the unsigned XPI is refused ("not verified")
until that pref is off. The profile's `user.js` sets it to `false` (takes effect on
restart; or flip it in `about:config` for immediate effect). Then:

```
npm run build-xpi
zen-browser ~/zen-control/zen-control.xpi     # then click "Add" in the prompt
```

Tabs that were open before the install get the content script injected on
first use. Privileged pages (about:, addons.mozilla.org, moz-extension:) can't
be scripted; navigate to an http(s) URL first.

After editing `extension/`, bump `version` in `manifest.json`, rebuild, and
re-open the XPI (or use about:debugging → Load Temporary Add-on for quick tests).

## Claude Code side

Registered with:

```
claude mcp add --scope user zen-browser -- node /home/zjones/zen-control/server/index.js
```

Tools: `tabs_list`, `tab_new`, `tab_select`, `tab_close`, `navigate`, `go_back`,
`go_forward`, `reload`, `read_page`, `find`, `get_text`, `click`, `hover`,
`type`, `press_key`, `select_option`, `scroll`, `wait_for`, `screenshot`,
`evaluate`, `console_logs`, `browser_status`.

Typical flow: `navigate` → `read_page` (get refs like `e12`) → `click`/`type`
with a ref → `screenshot` to verify.

`type` works on React-controlled inputs (it goes through the native value
setter and fires `input`/`change`). Its result includes a `validation` field
when the field is rejected (native constraint message, `aria-invalid`, or
nearby error text) — check it before assuming a form will submit.

## Security notes

- The WebSocket only listens on 127.0.0.1, but any local process could connect
  to it and drive the browser. Don't run this on a shared machine.
- The extension has `<all_urls>` access; Claude can read and act on any page in
  the profile it's installed in, including logged-in sessions. Use a separate
  Zen profile if you want isolation.
- `ZEN_CONTROL_PORT` overrides the port (set it for both the server env and in
  `background.js`).
