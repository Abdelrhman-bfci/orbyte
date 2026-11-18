#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="${1:-x64}"
VERSION="b12387"

case "${ARCH}" in
	x64)
		SHA256="9c58ebcd5a704e879cfadf2bbcb1fb1ec8ad4a5bec761fc58b3515864dd5e37a"
		;;
	arm64)
		SHA256="cb6acd002e11ebdad9eca716c72a7a5275afbb0ae9be36d25a9199bf306a67bf"
		;;
	*)
		echo "Usage: $0 [x64|arm64]" >&2
		exit 2
		;;
esac

ASSET="llama-${VERSION}-bin-ubuntu-${ARCH}.tar.gz"
URL="https://github.com/ggml-org/llama.cpp/releases/download/${VERSION}/${ASSET}"
TARGET="${ROOT}/resources/local-llm/linux-${ARCH}"
TEMP_ROOT="$(mktemp -d "/tmp/orbyte-llama-${ARCH}.XXXXXX")"
ARCHIVE="${TEMP_ROOT}/${ASSET}"
EXTRACTED="${TEMP_ROOT}/extracted"

cleanup() {
	rm -rf "${TEMP_ROOT}"
}
trap cleanup EXIT

echo "[Orbyte] Downloading ${URL}..."
curl -fL --retry 3 --connect-timeout 15 --max-time 300 -o "${ARCHIVE}" "${URL}"

echo "${SHA256}  ${ARCHIVE}" | shasum -a 256 -c -

mkdir -p "${EXTRACTED}" "${TARGET}"
tar -xzf "${ARCHIVE}" -C "${EXTRACTED}"

rsync -a \
	--include='llama-server' \
	--include='*.so' \
	--include='*.so.*' \
	--exclude='*' \
	"${EXTRACTED}/llama-${VERSION}/" "${TARGET}/"
cp "${EXTRACTED}/llama-${VERSION}/LICENSE" "${TARGET}/llama.cpp-LICENSE"
chmod +x "${TARGET}/llama-server"

echo "[Orbyte] Installed Linux ${ARCH} llama.cpp ${VERSION} runtime at ${TARGET}."
