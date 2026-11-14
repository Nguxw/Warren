/**
 * Creates the Ed25519 key pair releases are signed with.
 *
 *   bun scripts/release-key.ts <private-key-file>
 *
 * The private key (PKCS #8, base64) is written to the file with mode 0600 and goes into the
 * repository's Actions secret WARREN_RELEASE_SIGNING_KEY; it never enters the repository. The
 * public key (raw, base64) is printed, for RELEASE_PUBLIC_KEY in apps/daemon/src/runtime/updates.ts.
 * A new key pair means binaries already installed stop accepting updates, so keep the old one.
 */
import { existsSync, writeFileSync } from "node:fs";

const [file] = process.argv.slice(2);
if (!file) throw new Error("usage: bun scripts/release-key.ts <private-key-file>");
if (existsSync(file)) throw new Error(`${file} exists; refusing to replace a signing key`);

const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
  "base64",
);
const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString(
  "base64",
);
writeFileSync(file, `${privateKey}\n`, { mode: 0o600 });
console.log(`private key written to ${file} (keep it safe; add it as WARREN_RELEASE_SIGNING_KEY)`);
console.log(`public key: ${publicKey}`);
