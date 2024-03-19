#!/usr/local/bin/python3

"""
For each file in examples/*.mjs, transform it and
generate files .html-includes/side-by-side/*.html
with a two-column table containing before and after
JavaScript stylized with pygments.

Those can be <include>d into index.html.
"""

import os
import os.path
import subprocess
import sys

from pygments import highlight
from pygments.lexers import JavascriptLexer
from pygments.formatters import HtmlFormatter

if __name__ == '__main__':
    project_dir = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))

    examples_dir = os.path.join(project_dir, 'examples')

    mjs_files = [os.path.join(examples_dir, f)
                 for f in os.listdir(examples_dir)
                 if f.endswith('.mjs')]

    out_dir = os.path.join(project_dir, '.html-includes', 'side-by-side')
    try:
        os.makedirs(out_dir)
    except FileExistsError: pass

    for mjs_file in mjs_files:
        print(f'Translating example {mjs_file}', file=sys.stderr)
        translation = subprocess.check_output(
            ['node',
             '--input-type=module',
             '-e', 'import {transform} from "./src/comehere.mjs"; console.log(transform(fs.readFileSync(process.argv[1], {encoding: "UTF-8"})).code)',
             '--', mjs_file]
        )
        original = open(mjs_file, 'r', encoding='utf-8').read()

        left_html = highlight(original, JavascriptLexer(), HtmlFormatter())
        right_html = highlight(translation, JavascriptLexer(), HtmlFormatter())

        # fit the right height to the left height
        n_lines = len(original.split('\n'))
        expected_prefix = '<div class="highlight">'
        assert right_html.startswith(expected_prefix)
        right_html = f'<div class="highlight" style="height: {n_lines}ex">{right_html[len(expected_prefix):]}'

        html = f'<table class="example-display"><tr valign="top"><td class="left" width="50%">{left_html}</td><td class="right" width="50%">{right_html}</td></tr></table>'

        out_file_path = os.path.join(
            out_dir, os.path.basename(mjs_file[:-4] + '.html')
        )

        with open(out_file_path, 'w', encoding='utf-8') as out_file:
            out_file.write(html)

