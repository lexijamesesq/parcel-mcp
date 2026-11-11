#!/usr/bin/env bash
# tag-package-release.sh <package_dir> <package_name>
# Trusted-main release owner. Tags are immutable and annotated; a Release is cut for the tag's own source.
set -euo pipefail
PACKAGE_DIR="$1"
PACKAGE_NAME="$2"
CURRENT_VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]+"/package.json"))["version"])' "$PACKAGE_DIR")
TAG="${PACKAGE_NAME}--v${CURRENT_VERSION}"
SOURCE=$(git rev-parse HEAD)
REMOTE=$(git ls-remote --tags origin "refs/tags/$TAG" "refs/tags/$TAG^{}")
if [[ -n "$REMOTE" ]]; then
	SOURCE=$(printf '%s\n' "$REMOTE" | awk '$2 ~ /\^\{\}$/ {print $1}')
	[[ "$SOURCE" =~ ^[0-9a-f]{40}$ ]] || {
		echo "FAIL: $TAG must be annotated" >&2
		exit 1
	}
	git cat-file -e "$SOURCE^{commit}" 2>/dev/null || git fetch --no-tags origin "$SOURCE"
fi
confirm_tag_source() {
	local winner
	winner=$(git ls-remote --tags origin "refs/tags/$TAG^{}" | awk '{print $1}')
	[[ "$winner" == "$SOURCE" ]] || {
		echo "FAIL: $TAG source changed during release; rerun against the winning tag" >&2
		exit 1
	}
}
if [[ -z "$REMOTE" ]]; then
	echo "$PACKAGE_NAME: tagging $TAG"
	git tag -a "$TAG" "$SOURCE" -m "$TAG"
	if ! git push origin "refs/tags/$TAG"; then
		echo "$PACKAGE_NAME: push rejected; verifying the winning tag"
	fi
fi
confirm_tag_source
if ! gh release view "$TAG" >/dev/null 2>&1; then
	PREV_TAG=$(git tag -l "${PACKAGE_NAME}--v*" --sort=-v:refname | grep -vxF "$TAG" | head -1 || true)
	notes=(--generate-notes)
	[[ -n "$PREV_TAG" ]] && notes+=(--notes-start-tag "$PREV_TAG")
	if ! gh release create "$TAG" "${notes[@]}"; then
		gh release view "$TAG" >/dev/null
	fi
fi
echo "$PACKAGE_NAME: verified $TAG release"
