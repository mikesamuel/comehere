#!/bin/bash

set -e

cd "$(dirname "$0")/.."

if ! [ -d scripts ]; then
    echo "Expected a scripts/ directory!"
    exit -1
fi

rm -rf ./_site
mkdir  ./_site

for f in $(git ls-files | egrep '^src/|^styles/|\*.html'); do
    dest_dir=./_site/"$(dirname "$f")"
    if ! [ -d "$dest_dir" ]; then
        mkdir -p "$dest_dir"
    fi
    cp "$f" ./_site/"$f"
done

npm install
importmap=./_site/importmap.json
echo -n '{
  "imports": {
    "comehere": "./src/comehere.mjs"' > "$importmap"
for dir in $(npm ls --omit=dev --all --parseable | sort | uniq | grep node_modules); do
    relpath="${dir#$PWD/node_modules/}"
    dest="bundled/$relpath"
    mkdir -p ./_site/"$dest"
    cp -r "node_modules/$relpath" ./_site/"$dest"
    echo -n ',
    "'"$relpath/"'": "/'"$dest"'"' >> "$importmap"
done
echo -n '
  }
}' >> "$importmap"
