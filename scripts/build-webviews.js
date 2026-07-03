// Bundles webview TypeScript sources into runnable IIFE bundles via esbuild.
//
// Outputs:
//   media/terminal/dist/bridge.js   ← from media/terminal/src/bridge.ts
//   media/settings/dist/settings.js ← from media/settings/src/settings.ts
//   media/approval/dist/approval.js ← from media/approval/src/approval.ts
//
// Globals in the webview runtime (provided by <script> tags from
// media/terminal/vendor/) are NOT bundled — declared as externals so esbuild
// leaves the references intact.

const esbuild = require("esbuild");
const path = require("path");

const targets = [
  {
    entry: "media/terminal/src/bridge.ts",
    out:   "media/terminal/dist/bridge.js",
  },
  {
    entry: "media/settings/src/settings.ts",
    out:   "media/settings/dist/settings.js",
  },
  {
    entry: "media/approval/src/approval.ts",
    out:   "media/approval/dist/approval.js",
  },
];

const watch = process.argv.includes("--watch");

async function buildOne(t) {
  const ctx = await esbuild.context({
    entryPoints: [t.entry],
    outfile: t.out,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    sourcemap: "inline",
    logLevel: "info",
    // Globals provided by <script> tags in the webview HTML — must NOT be
    // bundled. esbuild treats `external` as opaque package names; for true
    // globals we use the "globals" trick: the webview .ts files reference them
    // via `declare const Terminal: ...` so esbuild emits a bare identifier.
  });
  if (watch) {
    await ctx.watch();
    console.log(`[build-webviews] watching ${t.entry}`);
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log(`[build-webviews] built ${path.basename(t.out)}`);
  }
}

(async () => {
  try {
    for (const t of targets) await buildOne(t);
    if (watch) {
      // Keep process alive in watch mode
      await new Promise(() => {});
    }
  } catch (e) {
    console.error("[build-webviews] failed:", e);
    process.exit(1);
  }
})();
