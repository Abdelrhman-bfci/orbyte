#!/usr/bin/env bash

set -euo pipefail

case "${ORBYTE_TARGET_ARCH:-}" in
	x64|arm64) ;;
	*)
		echo "[Orbyte] ORBYTE_TARGET_ARCH must be x64 or arm64." >&2
		exit 2
		;;
esac

echo "[Orbyte] Preparing an isolated Linux ${ORBYTE_TARGET_ARCH} source tree..."
rsync -a --delete \
	--exclude='/.build/' \
	--exclude='/.git/' \
	--exclude='/dist/' \
	--exclude='/node_modules/' \
	--exclude='/out/' \
	--exclude='/out-*/' \
	--exclude='/resources/local-llm/' \
	--exclude='node_modules/' \
	/source/ /work/src/

cd /work/src

# The host repository is mounted read-only and its 3+ GB .git directory is not
# copied into the cross-build workspace. Give the snapshot a small writable Git
# directory while borrowing the host object database. VS Code's postinstall
# writes local Git config, and the product build reads the current commit.
echo "[Orbyte] Preparing writable Git metadata for the isolated source tree..."
rm -rf .git
git init --quiet
mkdir -p .git/objects/info
printf '%s\n' /source/.git/objects > .git/objects/info/alternates
source_head="$(git --git-dir=/source/.git rev-parse HEAD)"
git update-ref refs/heads/orbyte-build "${source_head}"
git symbolic-ref HEAD refs/heads/orbyte-build

# Some source exports omit contributor-only agent harness files. The upstream
# postinstall only needs these paths so it can create compatibility symlinks.
mkdir -p .github .agents/skills
if [[ ! -f .github/copilot-instructions.md ]]; then
	printf '# Orbyte agent instructions\n\nSee AGENTS.md.\n' > .github/copilot-instructions.md
fi

# Keep large Playwright downloads in the persistent cross-build workspace so a
# corrected/retried build does not fetch them again in a fresh container.
export PLAYWRIGHT_BROWSERS_PATH=/work/cache/ms-playwright

echo "[Orbyte] Verifying the bundled Linux local-LLM runtime..."
"resources/local-llm/linux-${ORBYTE_TARGET_ARCH}/llama-server" --version

dependency_hash="$(sha256sum pnpm-lock.yaml package.json .nvmrc .pnpmfile.mjs | sha256sum | cut -d ' ' -f 1)"
dependency_stamp="/work/cache/dependencies-${ORBYTE_TARGET_ARCH}.sha256"
if [[ -d node_modules/.pnpm && -f "${dependency_stamp}" && "$(<"${dependency_stamp}")" == "${dependency_hash}" ]]; then
	echo "[Orbyte] Reusing verified Linux dependencies from the persistent workspace."
else
	echo "[Orbyte] Installing Linux dependencies with the frozen lockfile..."
	pnpm install --frozen-lockfile
	printf '%s\n' "${dependency_hash}" > "${dependency_stamp}"
fi

echo "[Orbyte] Building the Linux ${ORBYTE_TARGET_ARCH} application..."
if [[ "${ORBYTE_RESUME_PACKAGE:-0}" == "1" ]]; then
	if [[ ! -d out-vscode ]]; then
		echo "[Orbyte] Cannot resume packaging because out-vscode is missing." >&2
		exit 1
	fi
	echo "[Orbyte] Reusing the completed workbench bundle and resuming Linux packaging..."
	pnpm run gulp "vscode-linux-${ORBYTE_TARGET_ARCH}-ci"
else
	pnpm run "orbyte:build:linux:${ORBYTE_TARGET_ARCH}"
fi

archive="/dist/Orbyte-linux-${ORBYTE_TARGET_ARCH}.tar.gz"
echo "[Orbyte] Creating ${archive}..."
tar -C /work -czf "${archive}" "VSCode-linux-${ORBYTE_TARGET_ARCH}"

echo "[Orbyte] Linux package completed: ${archive}"
