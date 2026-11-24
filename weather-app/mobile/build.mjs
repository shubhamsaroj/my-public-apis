import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, statSync } from "node:fs";

const out = "www";
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/fonts`, { recursive: true });

await build({
  entryPoints: ["src/main.js"],
  bundle: true,
  minify: true,
  format: "esm",
  target: ["chrome89"],
  outfile: `${out}/app.js`,
  legalComments: "none",
});

await build({
  entryPoints: ["src/styles.css"],
  bundle: true,
  minify: true,
  target: ["chrome89"],
  external: ["*.woff2"],
  outfile: `${out}/styles.css`,
});

cpSync("src/index.html", `${out}/index.html`);
// Bundled font (SIL Open Font License) — no network font requests at runtime.
cpSync("node_modules/@fontsource-variable/outfit/files/outfit-latin-wght-normal.woff2", `${out}/fonts/outfit.woff2`);

const kb = (f) => (statSync(`${out}/${f}`).size / 1024).toFixed(1);
console.log(`Built www/  app.js ${kb("app.js")} KB · styles.css ${kb("styles.css")} KB · font ${kb("fonts/outfit.woff2")} KB`);
