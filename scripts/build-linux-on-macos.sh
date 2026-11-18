#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="${1:-x64}"
DEFAULT_MIN_FREE_GB=25
if [[ "${ORBYTE_RESUME_PACKAGE:-0}" == "1" ]]; then
	DEFAULT_MIN_FREE_GB=10
fi
MIN_FREE_GB="${ORBYTE_MIN_FREE_GB:-${DEFAULT_MIN_FREE_GB}}"

case "${ARCH}" in
	x64)
		DOCKER_PLATFORM="linux/amd64"
		;;
	arm64)
		DOCKER_PLATFORM="linux/arm64"
		;;
	*)
		echo "Usage: $0 [x64|arm64]" >&2
		exit 2
		;;
esac

RUNTIME="${ROOT}/resources/local-llm/linux-${ARCH}"
SERVER="${RUNTIME}/llama-server"
WORK_ROOT="${ROOT}/.build/linux-cross/${ARCH}"
DIST="${ROOT}/dist"
IMAGE="orbyte-linux-builder:${ARCH}"
ERRORS=0

fail_preflight() {
	echo "[Orbyte] ERROR: $1" >&2
	ERRORS=$((ERRORS + 1))
}

if [[ "$(uname -s)" != "Darwin" ]]; then
	fail_preflight "This helper is for macOS. On Linux, run pnpm run orbyte:build:linux:${ARCH}."
fi

if ! command -v docker >/dev/null 2>&1; then
	fail_preflight "Docker Desktop is not installed or docker is not on PATH."
elif ! docker info >/dev/null 2>&1; then
	fail_preflight "Docker Desktop is not running. Start Docker Desktop and wait until the engine is ready."
fi

if [[ ! -f "${SERVER}" ]]; then
	fail_preflight "Linux runtime not found: ${SERVER}"
elif [[ ! -x "${SERVER}" ]]; then
	fail_preflight "Linux runtime is not executable. Run: chmod +x '${SERVER}'"
fi

if [[ "${ORBYTE_SKIP_DISK_CHECK:-0}" != "1" ]]; then
	FREE_KB="$(df -Pk "${ROOT}" | awk 'NR == 2 { print $4 }')"
	FREE_GB=$((FREE_KB / 1024 / 1024))
	if (( FREE_GB < MIN_FREE_GB )); then
		fail_preflight "Only ${FREE_GB} GB is free; at least ${MIN_FREE_GB} GB is required."
	fi
fi

if (( ERRORS > 0 )); then
	echo "[Orbyte] Preflight failed with ${ERRORS} problem(s); no files were changed." >&2
	exit 1
fi

mkdir -p \
	"${WORK_ROOT}/src/resources/local-llm/linux-${ARCH}" \
	"${DIST}"

NODE_VERSION="$(tr -d '[:space:]' < "${ROOT}/.nvmrc")"

echo "[Orbyte] Building container ${IMAGE} for ${DOCKER_PLATFORM}..."
docker build \
	--platform "${DOCKER_PLATFORM}" \
	--build-arg "NODE_VERSION=${NODE_VERSION}" \
	--tag "${IMAGE}" \
	"${ROOT}/build/docker/orbyte-linux"

echo "[Orbyte] Starting isolated Linux build..."
docker run --rm \
	--platform "${DOCKER_PLATFORM}" \
	--env "ORBYTE_TARGET_ARCH=${ARCH}" \
	--env "ORBYTE_RESUME_PACKAGE=${ORBYTE_RESUME_PACKAGE:-0}" \
	--env "GOMAXPROCS=${ORBYTE_GOMAXPROCS:-2}" \
	--mount "type=bind,src=${ROOT},dst=/source,readonly" \
	--mount "type=bind,src=${WORK_ROOT},dst=/work" \
	--mount "type=bind,src=${DIST},dst=/dist" \
	--mount "type=bind,src=${RUNTIME},dst=/work/src/resources/local-llm/linux-${ARCH},readonly" \
	"${IMAGE}"

echo "[Orbyte] Artifact: ${DIST}/Orbyte-linux-${ARCH}.tar.gz"
