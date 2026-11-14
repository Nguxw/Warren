import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

/**
 * Releases and updates.
 *
 * A release on GitHub carries the binaries and a manifest, `release.json`, that lists each
 * file with its SHA-256, signed with Warren's Ed25519 release key (`release.json.sig`). An update
 * is installed only if:
 * 1. the manifest's signature verifies against the public key compiled into this binary, and
 * 2. the downloaded file's SHA-256 is the one the signed manifest names.
 * Checksums alone would not do: whoever could replace a file could replace its checksum too.
 * The private key lives only in the repository's Actions secrets, so a tampered release page
 * cannot produce an update this binary accepts.
 */

/** Where releases are published. */
export const RELEASE_REPO = "Nguxw/Warren";

/** The Ed25519 public key releases are signed with (raw, base64). */
export const RELEASE_PUBLIC_KEY = "Fh5fKq6H/mGH/P1Jxt6SYUulo4Zxhzrt7MVN0W6/B3Y=";

export const ReleaseAsset = z.object({
  name: z.string().regex(/^[\w.-]+$/),
  kind: z.enum(["cli", "desktop"]),
  platform: z.literal("darwin"),
  arch: z.enum(["arm64", "x64"]),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().positive(),
});
export type ReleaseAsset = z.infer<typeof ReleaseAsset>;

export const ReleaseManifest = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/),
  publishedAt: z.string().optional(),
  assets: z.array(ReleaseAsset),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;

export interface UpdateStatus {
  current: string;
  latest?: string;
  available: boolean;
  /** The release page, for its notes. */
  url?: string;
  notes?: string;
  checkedAt?: number;
  /** No release has been published yet: nothing to update to, and nothing wrong. */
  unpublished?: boolean;
  error?: string;
}

/** An update that cannot be trusted or installed. */
export class UpdateError extends Error {
  constructor(
    message: string,
    readonly code?: "unpublished",
  ) {
    super(message);
  }
}

/** Compares `x.y.z` versions; a pre-release (`1.2.0-beta.1`) comes before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Whether `signature` (base64) is a valid Ed25519 signature of `message` by `publicKey`. */
export async function verifySignature(
  message: Uint8Array,
  signature: string,
  publicKey: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      Buffer.from(publicKey, "base64"),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      Buffer.from(signature.trim(), "base64"),
      new Uint8Array(message),
    );
  } catch {
    return false;
  }
}

/** Signs `message` with an Ed25519 private key (PKCS #8, base64), as the release build does. */
export async function signMessage(message: Uint8Array, privateKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Buffer.from(privateKey.trim(), "base64"),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  return Buffer.from(
    await crypto.subtle.sign({ name: "Ed25519" }, key, new Uint8Array(message)),
  ).toString("base64");
}

export function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Where releases come from; GitHub by default, a fake in tests. */
export interface ReleaseSource {
  /** The latest release: its page, notes, and download URL by file name. */
  latest(): Promise<{ url: string; notes?: string; files: Record<string, string> }>;
  download(url: string): Promise<Uint8Array>;
}

export function githubReleases(repo = RELEASE_REPO, fetcher: typeof fetch = fetch): ReleaseSource {
  // A plain client name: no details of the person or the machine go with the request.
  const headers = { "User-Agent": "warren-updater", Accept: "application/vnd.github+json" };
  return {
    async latest() {
      const res = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers,
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 404)
        throw new UpdateError("no release has been published yet", "unpublished");
      if (!res.ok) throw new UpdateError(`GitHub answered ${res.status}`);
      const body = (await res.json()) as {
        html_url: string;
        body?: string;
        assets: { name: string; browser_download_url: string }[];
      };
      return {
        url: body.html_url,
        ...(body.body && { notes: body.body }),
        files: Object.fromEntries(body.assets.map((a) => [a.name, a.browser_download_url])),
      };
    },
    async download(url) {
      const res = await fetcher(url, { headers, signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok) throw new UpdateError(`download failed: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

export class Updater {
  constructor(
    private readonly options: {
      current: string;
      source?: ReleaseSource;
      publicKey?: string;
      arch?: string;
    },
  ) {}

  private get source(): ReleaseSource {
    return this.options.source ?? githubReleases();
  }

  /** The latest release's manifest, once its signature has verified. */
  async latest(): Promise<{
    manifest: ReleaseManifest;
    url: string;
    notes?: string;
    files: Record<string, string>;
  }> {
    const release = await this.source.latest();
    const manifestUrl = release.files["release.json"];
    const signatureUrl = release.files["release.json.sig"];
    if (!manifestUrl || !signatureUrl) throw new UpdateError("the release has no signed manifest");
    const [manifestBytes, signature] = await Promise.all([
      this.source.download(manifestUrl),
      this.source.download(signatureUrl).then((b) => new TextDecoder().decode(b)),
    ]);
    const key = this.options.publicKey ?? RELEASE_PUBLIC_KEY;
    if (!(await verifySignature(manifestBytes, signature, key))) {
      throw new UpdateError("the release's signature does not verify; it is not installed");
    }
    const manifest = ReleaseManifest.parse(JSON.parse(new TextDecoder().decode(manifestBytes)));
    return { manifest, ...release };
  }

  async check(): Promise<UpdateStatus> {
    const { manifest, url, notes } = await this.latest();
    return {
      current: this.options.current,
      latest: manifest.version,
      available: compareVersions(manifest.version, this.options.current) > 0,
      url,
      ...(notes && { notes }),
    };
  }

  /** Downloads an asset of the latest release and checks it against the signed manifest. */
  async fetchAsset(
    kind: ReleaseAsset["kind"],
  ): Promise<{ asset: ReleaseAsset; bytes: Uint8Array; version: string }> {
    const { manifest, files } = await this.latest();
    const arch = this.options.arch ?? process.arch;
    const asset = manifest.assets.find(
      (a) => a.kind === kind && a.platform === "darwin" && a.arch === arch,
    );
    if (!asset) throw new UpdateError(`the release has no ${kind} for darwin-${arch}`);
    const url = files[asset.name];
    if (!url) throw new UpdateError(`the release lists ${asset.name} but does not carry it`);
    const bytes = await this.source.download(url);
    if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256) {
      throw new UpdateError(
        `${asset.name} does not match the signed manifest; it is not installed`,
      );
    }
    return { asset, bytes, version: manifest.version };
  }

  /**
   * Replaces the binary at `target` with the latest release's. The new file is unpacked and
   * made executable next to the old one, then renamed over it, so the path never holds a
   * partial binary; a running process keeps the old file until it restarts.
   */
  async updateBinary(target: string): Promise<string> {
    const { bytes, version } = await this.fetchAsset("cli");
    const work = mkdtempSync(join(tmpdir(), "warren-update-"));
    try {
      const archive = join(work, "warren.tar.gz");
      writeFileSync(archive, bytes);
      await run(["tar", "-xzf", archive, "-C", work]);
      const unpacked = join(work, "warren");
      if (!existsSync(unpacked)) throw new UpdateError("the archive holds no warren binary");
      const staged = join(dirname(target), `.${basename(target)}.update`);
      writeFileSync(staged, readFileSync(unpacked));
      await chmod(staged, 0o755);
      renameSync(staged, target);
      return version;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** Replaces the desktop app at `app` (a Warren.app) with the latest release's, the same way. */
  async updateApp(app: string): Promise<string> {
    const { bytes, version } = await this.fetchAsset("desktop");
    const work = mkdtempSync(join(dirname(app), ".warren-update-"));
    try {
      const archive = join(work, "Warren.app.zip");
      writeFileSync(archive, bytes);
      await run(["ditto", "-x", "-k", archive, work]);
      const unpacked = join(work, "Warren.app");
      if (!existsSync(join(unpacked, "Contents", "Info.plist"))) {
        throw new UpdateError("the archive holds no Warren.app");
      }
      const old = join(work, "Warren.old.app");
      renameSync(app, old);
      try {
        renameSync(unpacked, app);
      } catch (error) {
        renameSync(old, app);
        throw error;
      }
      return version;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

/** The desktop app, if installed where macOS puts applications. */
export function installedApp(home = process.env.HOME ?? ""): string | undefined {
  return ["/Applications/Warren.app", join(home, "Applications", "Warren.app")].find((path) =>
    existsSync(join(path, "Contents", "Info.plist")),
  );
}

/** Whether this process is the compiled single binary, the only form that updates itself. */
export function isCompiledBinary(): boolean {
  return import.meta.path.startsWith("/$bunfs/");
}

async function run(argv: string[]): Promise<void> {
  const child = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
  if ((await child.exited) !== 0) {
    throw new UpdateError(`${argv[0]} failed: ${(await new Response(child.stderr).text()).trim()}`);
  }
}
