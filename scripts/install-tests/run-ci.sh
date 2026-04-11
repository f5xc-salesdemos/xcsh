#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

section() {
	echo ""
	echo "=== $1 ==="
}

smoke_cli() {
	local omp_bin="$1"
	"$omp_bin" --version
	"$omp_bin" --help >/dev/null
	"$omp_bin" stats --summary >/dev/null
}

find_tarball() {
	local pattern="$1"
	local matches=()
	shopt -s nullglob
	matches=("$pattern")
	shopt -u nullglob

	if [ "${#matches[@]}" -ne 1 ]; then
		echo "Expected exactly one tarball matching: $pattern"
		exit 1
	fi

	echo "${matches[0]}"
}

section "Binary install smoke"
bun --cwd=packages/natives run build
bun --cwd=packages/coding-agent run build

BINARY_DIR="$WORK_DIR/binary-bin"
mkdir -p "$BINARY_DIR"
cp packages/coding-agent/dist/xcsh "$BINARY_DIR/xcsh"
shopt -s nullglob
native_addons=(packages/natives/native/pi_natives.*.node)
shopt -u nullglob
if [ "${#native_addons[@]}" -eq 0 ]; then
	echo "No native addon files found in packages/natives/native"
	exit 1
fi
cp "${native_addons[@]}" "$BINARY_DIR/"

smoke_cli "$BINARY_DIR/xcsh"

section "Source install smoke"
SOURCE_BUN_HOME="$WORK_DIR/bun-source"
(
	export BUN_INSTALL="$SOURCE_BUN_HOME"
	export PATH="$BUN_INSTALL/bin:$PATH"
	bun --cwd="$ROOT_DIR/packages/coding-agent" link
	smoke_cli "$BUN_INSTALL/bin/xcsh"
)

section "Tarball install smoke"
TARBALL_DIR="$WORK_DIR/tarballs"
mkdir -p "$TARBALL_DIR"
for pkg in utils natives ai agent tui stats coding-agent; do
	(
		cd "$ROOT_DIR/packages/$pkg"
		bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null
	)
done

utils_tgz="$(find_tarball "$TARBALL_DIR"/f5xc-salesdemos-pi-utils-*.tgz)"
natives_tgz="$(find_tarball "$TARBALL_DIR"/f5xc-salesdemos-pi-natives-*.tgz)"
ai_tgz="$(find_tarball "$TARBALL_DIR"/f5xc-salesdemos-pi-ai-*.tgz)"
agent_tgz="$(find_tarball "$TARBALL_DIR"/f5xc-salesdemos-pi-agent-core-*.tgz)"
tui_tgz="$(find_tarball "$TARBALL_DIR"/f5xc-salesdemos-pi-tui-*.tgz)"
stats_tgz="$(find_tarball "$TARBALL_DIR"/f5xc-salesdemos-xcsh-stats-*.tgz)"
coding_agent_tgz="$(find_tarball "$TARBALL_DIR"/f5xc-salesdemos-xcsh-[0-9]*.tgz)"

TARBALL_APP_DIR="$WORK_DIR/tarball-install"
mkdir -p "$TARBALL_APP_DIR"
(
	cd "$TARBALL_APP_DIR"
	bun init -y >/dev/null

	# Write overrides so bun resolves inter-package deps from tarballs, not the registry
	# (version 12.x.y hasn't been published yet when CI runs pre-release)
	node -e "
		const pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf8'));
		pkg.overrides = {
			'@f5xc-salesdemos/pi-utils': '$utils_tgz',
			'@f5xc-salesdemos/pi-natives': '$natives_tgz',
			'@f5xc-salesdemos/pi-ai': '$ai_tgz',
			'@f5xc-salesdemos/pi-agent-core': '$agent_tgz',
			'@f5xc-salesdemos/pi-tui': '$tui_tgz',
			'@f5xc-salesdemos/xcsh-stats': '$stats_tgz',
			'@f5xc-salesdemos/xcsh': '$coding_agent_tgz'
		};
		require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));
	"

	bun add "$utils_tgz" "$natives_tgz" "$ai_tgz" "$agent_tgz" "$tui_tgz" "$stats_tgz" "$coding_agent_tgz"
	smoke_cli ./node_modules/.bin/xcsh
)

section "Platform package structure verification"
(
	NPM_DIR="$ROOT_DIR/packages/natives/npm"
	for platform_dir in "$NPM_DIR"/*/; do
		pkg_name=$(basename "$platform_dir")
		pkg_json="$platform_dir/package.json"
		if [ ! -f "$pkg_json" ]; then
			echo "Missing package.json in $pkg_name"
			exit 1
		fi
		# Verify package.json has required fields: os, cpu, main
		for field in os cpu main; do
			if ! grep -q "\"$field\"" "$pkg_json"; then
				echo "Missing '$field' in $pkg_name/package.json"
				exit 1
			fi
		done
		echo "  $pkg_name: package.json valid"
	done
)

echo ""
echo "All install method smoke tests passed"
