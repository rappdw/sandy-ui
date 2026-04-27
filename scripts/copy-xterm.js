// Copies xterm.js + addon assets into media/terminal/vendor/ so the webview
// can load them via local resource URIs (no CDN, CSP-clean).

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dest = path.join(root, "media", "terminal", "vendor");
fs.mkdirSync(dest, { recursive: true });

const files = [
  ["@xterm/xterm/lib/xterm.js",                 "xterm.js"],
  ["@xterm/xterm/css/xterm.css",                "xterm.css"],
  ["@xterm/addon-fit/lib/addon-fit.js",         "addon-fit.js"],
  ["@xterm/addon-web-links/lib/addon-web-links.js", "addon-web-links.js"],
];

for (const [src, name] of files) {
  const from = path.join(root, "node_modules", src);
  const to   = path.join(dest, name);
  if (!fs.existsSync(from)) {
    console.error(`[copy-xterm] missing: ${from}`);
    process.exit(1);
  }
  fs.copyFileSync(from, to);
  console.log(`[copy-xterm] ${name}`);
}
