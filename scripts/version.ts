/**
 * Sets Warren's version everywhere it is written: package.json (the source of truth), the desktop
 * app's tauri.conf.json and Cargo.toml.
 *
 *   bun scripts/version.ts 0.2.0
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [version] = process.argv.slice(2);
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version))
  throw new Error("usage: bun scripts/version.ts X.Y.Z");
const root = join(import.meta.dir, "..");
const edit = (file: string, change: (text: string) => string) => {
  const path = join(root, file);
  writeFileSync(path, change(readFileSync(path, "utf8")));
};
edit("package.json", (t) => t.replace(/"version": "[^"]+"/, `"version": "${version}"`));
edit("apps/desktop/src-tauri/tauri.conf.json", (t) =>
  t.replace(/"version": "[^"]+"/, `"version": "${version}"`),
);
edit("apps/desktop/src-tauri/Cargo.toml", (t) =>
  t.replace(/^version = "[^"]+"/m, `version = "${version}"`),
);
console.log(`version ${version}; commit, then tag v${version} and push the tag to release`);
