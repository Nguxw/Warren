#!/bin/sh
# Installs the latest Warren release for this Mac:
#
#   curl -fsSL https://raw.githubusercontent.com/Nguxw/Warren/main/install.sh | sh
#
# The archive is checked against the release's SHA256SUMS before anything is installed. Later
# updates (`warren update`) also verify the release's signature.
set -eu

repo="Nguxw/Warren"
dir="${WARREN_INSTALL_DIR:-$HOME/.local/bin}"

[ "$(uname -s)" = "Darwin" ] || { echo "Warren releases are built for macOS." >&2; exit 1; }
case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo "Unsupported processor: $(uname -m)" >&2; exit 1 ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
base="https://github.com/$repo/releases/latest/download"
archive="warren-darwin-$arch.tar.gz"

echo "Downloading $archive…"
curl -fsSL "$base/$archive" -o "$tmp/$archive"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
(cd "$tmp" && grep " $archive\$" SHA256SUMS | shasum -a 256 -c - >/dev/null) || {
  echo "The download does not match the release's checksum; nothing was installed." >&2
  exit 1
}

tar -xzf "$tmp/$archive" -C "$tmp"
mkdir -p "$dir"
mv "$tmp/warren" "$dir/warren"
chmod 755 "$dir/warren"

echo "Installed $("$dir/warren" --version) at $dir/warren"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add $dir to your PATH, for example: echo 'export PATH=\"$dir:\$PATH\"' >> ~/.zshrc" ;;
esac
echo "Next: warren service install && warren open"
