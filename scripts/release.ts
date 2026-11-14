/**
 * Builds a release into dist/release: the single binary (CLI, daemon and interface) for both Mac
 * architectures, the desktop app if given, SHA256SUMS, and release.json with its signature.
 *
 *   bun scripts/release.ts [--desktop <Warren.app>] [--require-signature]
 *
 * The manifest is signed with WARREN_RELEASE_SIGNING_KEY (PKCS #8, base64), which must belong to
 * the public key compiled into the binaries; a build tagged vX.Y.Z must have version X.Y.Z in
 * every place a version is written.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import {
  RELEASE_PUBLIC_KEY,
  type ReleaseAsset,
  type ReleaseManifest,
  sha256,
  signMessage,
  VERSION,
  verifySignature,
} from "../apps/daemon/src/index.ts";

const { values } = parseArgs({
  options: { desktop: { type: "string" }, "require-signature": { type: "boolean" } },
});
const root = join(import.meta.dir, "..");
const out = join(root, "dist", "release");
const work = join(root, "dist", "release-build");

// One version everywhere, and the tag that asked for this build.
const tauri = JSON.parse(
  readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
);
const cargo = /^version = "([^"]+)"/m.exec(
  readFileSync(join(root, "apps/desktop/src-tauri/Cargo.toml"), "utf8"),
)?.[1];
for (const [where, version] of [
  ["tauri.conf.json", tauri.version],
  ["Cargo.toml", cargo],
] as const) {
  if (version !== VERSION)
    throw new Error(
      `${where} has version ${version}, package.json ${VERSION}; run bun scripts/version.ts`,
    );
}
const tag = process.env.GITHUB_REF_NAME;
if (tag?.startsWith("v") && tag !== `v${VERSION}`)
  throw new Error(`tag ${tag} does not match version ${VERSION}`);

// The key must be the one binaries trust, or every update would be refused.
const key = process.env.WARREN_RELEASE_SIGNING_KEY?.trim();
if (key) {
  const probe = new TextEncoder().encode("warren release key check");
  if (!(await verifySignature(probe, await signMessage(probe, key), RELEASE_PUBLIC_KEY))) {
    throw new Error("WARREN_RELEASE_SIGNING_KEY does not match RELEASE_PUBLIC_KEY");
  }
} else if (values["require-signature"]) {
  throw new Error("WARREN_RELEASE_SIGNING_KEY is not set");
}

rmSync(out, { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

async function run(argv: string[]) {
  const child = Bun.spawn(argv, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`${argv.join(" ")} failed`);
}

const assets: ReleaseAsset[] = [];
function add(file: string, kind: ReleaseAsset["kind"], arch: ReleaseAsset["arch"]) {
  const bytes = readFileSync(file);
  assets.push({
    name: basename(file),
    kind,
    platform: "darwin",
    arch,
    sha256: sha256(bytes),
    size: statSync(file).size,
  });
}

for (const arch of ["arm64", "x64"] as const) {
  const dir = join(work, arch);
  mkdirSync(dir, { recursive: true });
  await run([
    "bun",
    "build",
    "--compile",
    "--minify",
    "--sourcemap",
    `--target=bun-darwin-${arch}`,
    "apps/cli/src/main.ts",
    "--outfile",
    join(dir, "warren"),
  ]);
  const archive = join(out, `warren-darwin-${arch}.tar.gz`);
  await run(["tar", "-czf", archive, "-C", dir, "warren"]);
  add(archive, "cli", arch);
}

if (values.desktop) {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const archive = join(out, `Warren-darwin-${arch}.app.zip`);
  await run(["ditto", "-c", "-k", "--keepParent", values.desktop, archive]);
  add(archive, "desktop", arch);
}

const manifest: ReleaseManifest = {
  version: VERSION,
  publishedAt: new Date().toISOString(),
  assets,
};
const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(out, "release.json"), manifestBytes);
if (key) writeFileSync(join(out, "release.json.sig"), `${await signMessage(manifestBytes, key)}\n`);
const sums = [
  ...assets.map((a) => `${a.sha256}  ${a.name}`),
  `${sha256(manifestBytes)}  release.json`,
];
writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
rmSync(work, { recursive: true, force: true });
console.log(`release ${VERSION} in ${out}${key ? " (signed)" : " (unsigned)"}`);
