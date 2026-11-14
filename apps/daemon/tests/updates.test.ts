import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions,
  type Logger,
  RELEASE_PUBLIC_KEY,
  type ReleaseManifest,
  type ReleaseSource,
  sha256,
  signMessage,
  startDaemon,
  UpdateError,
  Updater,
  VERSION,
  verifySignature,
} from "../src/index.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "warren-updates-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function keyPair() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    privateKey: Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
      "base64",
    ),
    publicKey: Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64"),
  };
}

/** A tar.gz holding one file named `warren`, as a release's CLI archive does. */
async function cliArchive(content: string): Promise<Uint8Array> {
  const dir = join(root, `pack-${Math.random()}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "warren"), content);
  const out = join(dir, "warren.tar.gz");
  await Bun.spawn(["tar", "-czf", out, "-C", dir, "warren"]).exited;
  return new Uint8Array(readFileSync(out));
}

async function release(options: {
  version: string;
  archive: Uint8Array;
  privateKey: string;
  tamper?: boolean;
}) {
  const manifest: ReleaseManifest = {
    version: options.version,
    assets: [
      {
        name: "warren-darwin-arm64.tar.gz",
        kind: "cli",
        platform: "darwin",
        arch: "arm64",
        sha256: sha256(options.archive),
        size: options.archive.length,
      },
    ],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const signature = await signMessage(bytes, options.privateKey);
  const served = options.tamper
    ? new TextEncoder().encode(JSON.stringify({ ...manifest, version: "9.9.9" }))
    : bytes;
  const files: Record<string, Uint8Array> = {
    "release.json": served,
    "release.json.sig": new TextEncoder().encode(signature),
    "warren-darwin-arm64.tar.gz": options.archive,
  };
  const source: ReleaseSource = {
    latest: async () => ({
      url: "https://example.com/releases/v1",
      notes: "Fixes",
      files: Object.fromEntries(Object.keys(files).map((name) => [name, `fake://${name}`])),
    }),
    download: async (url) => files[url.replace("fake://", "")] as Uint8Array,
  };
  return { source, files };
}

test("versions compare by number, a pre-release before its release", () => {
  expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
  expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
  expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
});

test("the release key compiled in is a valid Ed25519 public key", async () => {
  await expect(
    crypto.subtle.importKey(
      "raw",
      Buffer.from(RELEASE_PUBLIC_KEY, "base64"),
      { name: "Ed25519" },
      false,
      ["verify"],
    ),
  ).resolves.toBeDefined();
});

describe("Updater", () => {
  test("a signed newer release is offered, and its binary replaces the old one", async () => {
    const { privateKey, publicKey } = await keyPair();
    const { source } = await release({
      version: "0.2.0",
      archive: await cliArchive("#!/bin/sh\necho new\n"),
      privateKey,
    });
    const updater = new Updater({ current: "0.1.0", source, publicKey, arch: "arm64" });
    expect(await updater.check()).toMatchObject({
      current: "0.1.0",
      latest: "0.2.0",
      available: true,
      notes: "Fixes",
    });

    const target = join(root, "warren");
    writeFileSync(target, "old");
    expect(await updater.updateBinary(target)).toBe("0.2.0");
    expect(readFileSync(target, "utf8")).toBe("#!/bin/sh\necho new\n");
    expect(statSync(target).mode & 0o111).toBeTruthy();
    expect(await new Updater({ current: "0.2.0", source, publicKey }).check()).toMatchObject({
      available: false,
    });
  });

  test("a manifest changed after signing, or signed by another key, is refused", async () => {
    const { privateKey, publicKey } = await keyPair();
    const archive = await cliArchive("x");
    const tampered = await release({ version: "0.2.0", archive, privateKey, tamper: true });
    await expect(
      new Updater({ current: "0.1.0", source: tampered.source, publicKey }).check(),
    ).rejects.toThrow(UpdateError);

    const other = await keyPair();
    const signedByOther = await release({
      version: "0.2.0",
      archive,
      privateKey: other.privateKey,
    });
    await expect(
      new Updater({ current: "0.1.0", source: signedByOther.source, publicKey }).check(),
    ).rejects.toThrow("signature does not verify");
  });

  test("a binary that differs from the signed manifest is not installed", async () => {
    const { privateKey, publicKey } = await keyPair();
    const { source, files } = await release({
      version: "0.2.0",
      archive: await cliArchive("good"),
      privateKey,
    });
    files["warren-darwin-arm64.tar.gz"] = await cliArchive("evil");
    const target = join(root, "warren");
    writeFileSync(target, "old");
    await expect(
      new Updater({ current: "0.1.0", source, publicKey, arch: "arm64" }).updateBinary(target),
    ).rejects.toThrow("does not match the signed manifest");
    expect(readFileSync(target, "utf8")).toBe("old");
    await expect(
      new Updater({ current: "0.1.0", source, publicKey, arch: "x64" }).fetchAsset("cli"),
    ).rejects.toThrow("no cli for darwin-x64");
  });

  test("signatures verify only for their own message and key", async () => {
    const { privateKey, publicKey } = await keyPair();
    const message = new TextEncoder().encode("hello");
    const signature = await signMessage(message, privateKey);
    expect(await verifySignature(message, signature, publicKey)).toBe(true);
    expect(await verifySignature(new TextEncoder().encode("hellO"), signature, publicKey)).toBe(
      false,
    );
    expect(await verifySignature(message, "not base64 !!", publicKey)).toBe(false);
  });
});

test("the daemon reports its version and the latest release; from source it does not install", async () => {
  const { privateKey, publicKey } = await keyPair();
  const { source } = await release({
    version: "99.0.0",
    archive: await cliArchive("x"),
    privateKey,
  });
  const quiet: Logger = { info() {}, error() {} };
  const home = join(root, "home");
  mkdirSync(home);
  const daemon = await startDaemon({
    home,
    port: 0,
    logger: quiet,
    updates: { source, publicKey, compiled: false },
  });
  try {
    const call = async (method: string, path: string) => {
      const res = await fetch(`${daemon.url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${daemon.info.token}` },
      });
      // biome-ignore lint/suspicious/noExplicitAny: tests inspect JSON responses loosely
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    expect((await call("GET", "/health")).body.version).toBe(VERSION);
    expect((await call("GET", "/update")).body.update).toMatchObject({
      current: VERSION,
      available: false,
      canInstall: false,
    });
    expect((await call("POST", "/update/check")).body.update).toMatchObject({
      latest: "99.0.0",
      available: true,
    });
    const install = await call("POST", "/update/install");
    expect(install.status).toBe(409);
    expect(install.body.error).toContain("run from source");
  } finally {
    await daemon.stop();
  }
});

test("before any release is published, a check reports that plainly rather than as an error", async () => {
  const source: ReleaseSource = {
    async latest() {
      throw new UpdateError("no release has been published yet", "unpublished");
    },
    async download() {
      throw new Error("not reached");
    },
  };
  const home = join(root, "home");
  mkdirSync(home);
  const daemon = await startDaemon({
    home,
    port: 0,
    logger: { info() {}, error() {} },
    updates: { source, publicKey: RELEASE_PUBLIC_KEY, compiled: false },
  });
  try {
    const res = await fetch(`${daemon.url}/update/check`, {
      method: "POST",
      headers: { Authorization: `Bearer ${daemon.info.token}` },
    });
    const { update } = (await res.json()) as { update: Record<string, unknown> };
    expect(update).toMatchObject({ available: false, unpublished: true });
    expect(update.error).toBeUndefined();
  } finally {
    await daemon.stop();
  }
});
