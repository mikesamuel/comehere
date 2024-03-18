#!/bin/bash

set -e

cd "$(dirname "$0")/.."

[ -f dist/index.html ]

MY_TMPDIR="$(cd "$TMPDIR" && stat -f '%R' "$(mktemp -d XXXXXX)")"
[ -d "$MY_TMPDIR" ]

DIST_TAR_FILE="$MY_TMPDIR"/dist.tar
tar cf "$DIST_TAR_FILE" dist
echo Contents of tarball
tar tf "$DIST_TAR_FILE"

REFERENCE="$PWD"
cd "$MY_TMPDIR"
git clone --reference "$REFERENCE" git@github.com:mikesamuel/comehere.git
cd comehere
echo Cloned into "$PWD"
git checkout github-pages

# Remove all files
for f in $(git ls-files); do
    git rm "$f"
done
# If a file still exists, undo the `git rm`
for f in $(tar tf "$DIST_TAR_FILE" | perl -ne 's/^dist\///; chomp; print "$_\n" if $_'); do
    git reset HEAD "$f" || true
done
# `git add` any files that are new or edited
tar xf "$DIST_TAR_FILE" --strip-components 1
for f in $(git ls-files --others --modified); do
    git add "$f"
done

echo To TEST, run the below and browse to http://[::]:8000/comehere/index.html
echo "cd $MY_TMPDIR; python3 -m http.server"
echo
echo To PUBLISH, run the below
echo "cd $MY_TMPDIR/comehere; git commit -s -m 'Pushing new version to github pages'; git push"
