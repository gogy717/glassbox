#!/usr/bin/env bash
# Cut a release. A tag carries the built `dist` and a package.json without the scripts npm would
# run, so `npx` and `npm install -g` from the git URL only download: npm hands its own global
# flag to the install that prepares a git clone, which links the clone into the global prefix
# instead of installing its devDependencies, and any package with a prepare script then fails
# under `npm install -g` (npm 11). The `release` branch follows the latest tag.
#
# Usage, on main with a clean tree after `npm run check`:  scripts/release.sh 0.8.1
# Then:  git push origin main v0.8.1 release
set -euo pipefail
v=${1:?usage: scripts/release.sh <version, e.g. 0.8.1>}
cd "$(git rev-parse --show-toplevel)"
[ "$(git branch --show-current)" = main ] || { echo "release.sh: run it on main" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "release.sh: the tree is not clean" >&2; exit 1; }
! git rev-parse -q --verify "refs/tags/v$v" >/dev/null || { echo "release.sh: v$v exists" >&2; exit 1; }

prev=$(node -p 'require("./package.json").version')
npm version "$v" --no-git-tag-version >/dev/null
perl -pi -e "s/glassbox#v\Q$prev\E\b/glassbox#v$v/g" README.md README.zh-CN.md
git add package.json package-lock.json README.md README.zh-CN.md
git commit -q -m "glassbox v$v"
npm run build >/dev/null

# The release commit: main's tree, plus dist without source maps, with the scripts stripped.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
node -e '
  const p = require("./package.json");
  for (const s of ["prepare", "build", "prepack", "preinstall", "install", "postinstall"]) delete p.scripts[s];
  process.stdout.write(JSON.stringify(p, null, 2) + "\n");
' > "$tmp/package.json"
export GIT_INDEX_FILE="$tmp/index"
git read-tree HEAD
git update-index --cacheinfo "100644,$(git hash-object -w "$tmp/package.json"),package.json"
find dist -type f ! -name '*.map' -print0 | xargs -0 git update-index --add --
tree=$(git write-tree)
unset GIT_INDEX_FILE
parents=(-p HEAD)
if git rev-parse -q --verify refs/heads/release >/dev/null; then parents+=(-p release); fi
commit=$(git commit-tree "$tree" "${parents[@]}" -m "glassbox v$v, built")
git tag "v$v" "$commit"
git branch -f release "$commit"
echo "v$v is $commit (release branch moved); next: git push origin main v$v release"
