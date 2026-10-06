
/**
 * A tool that allows for running a test based on a transcript of an
 * interactive shell session including:
 *
 * - Lines of code prefixed with '$ ' (a dollar-sign and a space) which,
 *   after stripping the prefix are passed to `execute` to produce a result.
 * - Lines of code prefixed with '->' that set the expectation for the
 *   preceding line of code.  The text, after stripping the prefix is
 *   compared to the `String(...)` of the last result
 *   and the test passes if all such expectations match (after stripping
 *   leading and trailing ASCII spaces).
 *
 * Adapted from the E-language tool:
 * https://erights.github.io/erights-org-website/elang/tools/updoc.html
 *
 * @param execute runs code in the test context.
 *   Just pass in `(x) => eval(x)`.  Yes, `eval` is evil; also evil:
 *   not testing your code, and loading test code in a prod environment.
 * @returns boolean whether all expectations were met.
 */
export function runUpdocTest(testName, updocText, execute) {
  // First, identify a common line prefix consisting solely of tabs and spaces
  // at the start so that we can de-indent backtick strings.
  //
  // Someone might write JavaScript like the below, and we should treat it as
  // if the `$` and `->` prefixes were at line starts.
  //
  // if (condition) {
  //  runUpdocTest('foo', `
  //                      $  123
  //                      -> 123
  //                      `, ...)
  // }

  let commonPrefix = null;
  for (let line of updocText.split(/^/gm)) {
    if (!/[^\t\n\r ]/.test(line)) {
      // skip blanks.
      continue;
    }
    let prefix = /^[ \t]*/.exec(line)
    if (commonPrefix === null) {
      [commonPrefix] = prefix;
    } else {
      let maxLength = Math.min(prefix.length, commonPrefix.length);
      let commonLength = 0;
      while (commonLength < maxLength && prefix[commonLength] === commonPrefix[commonLength]) {
        commonLength += 1;
      }
      if (commonPrefix.length > commonLength) {
        commonPrefix = commonPrefix.substring(commonLength);
      }
    }
    if (!commonPrefix) { break; }
  }
  commonPrefix = commonPrefix || '';

  // Split updocText into chunks.
  // Each chunk starts with `$ ` or `->` after the commonPrefix.
  // If a line with either prefix is indented by more than that, then it's not
  // significant, so you can indent a line to have it continue the previous chunk.

  // For chunks, we want to preserve the offset into the original, so we store [offset, chunkText] pairs.
  const offsetsAndChunks = [];
  {
    let splitAt = new RegExp(`^${commonPrefix}(?:[$][ \t]|->)`);
    let remaining = updocText; // Consumed left to right.
    let offset = 0;  // Of the start of remaining in updocText
    let pending = []; // Accumulates de-prefixed lines for the current chunk
    let startOffset = commonPrefix.length; // Offset of the current chunk in updocText.
    while (remaining) {
      // End a chunk if we're starting another.
      if (pending.length && splitAt.test(remaining)) {
        offsetsAndChunks.push([startOffset, pending.join('')]);
        startOffset = offset + commonPrefix.length;
        pending.length = 0;
      }

      let endMatch = /\r\n?|\n/.exec(remaining);
      // Position after next line separator if any.
      let end = endMatch ? endMatch.index + endMatch[0].length : remaining.length;
      let start = commonPrefix && remaining.startsWith(commonPrefix) ? commonPrefix.length : 0;
      pending.push(remaining.substring(start, end));
      remaining = remaining.substring(end);
      offset += end;
    }
    if (pending.length) {
      offsetsAndChunks.push([startOffset, pending.join('')]);
    }
  }

  const trim = (s) => s.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '');

  let expected = []; // Normalized updocText
  let actual = []; // Like updocText but with expectations replaced with computed results
  let result = undefined;
  let passed = true;
  for (let [offset, chunk] of offsetsAndChunks) {
    if (!/[^\t\n\r ]/.test(chunk)) {
      // Skip blanks
    } else {
      if (/^[$][ \t]/.test(chunk)) {
        chunk = trim(chunk.substring(2));
        result = execute(chunk);
        // TODO: trap exception as a result for failure expectations

        expected.push('$ ', chunk, '\n');
        actual.push('$ ', chunk, '\n');
      } else if (/^->/.test(chunk)) {
        chunk = chunk.substring(2);

        let want = trim(chunk);
        let got = trim(String(result));
        let passedChunk = want === got;
        if (!passedChunk) {
          passed = false;
        }
        let prefix = passedChunk ? '' : '❌';
        expected.push('-> ', want, '\n');
        actual.push(prefix, '-> ', got, '\n');
      } else {
        throw new Error(`${testName}: Malformed updoc ${JSON.stringify(chunk)} at offset ${offset} in ${JSON.stringify(updocText)}`);
      }
    }
  }

  console.group(`Updoc ${testName} ${passed ? '✅' : '❌'}`);
  {
    console.group(`expected`);
    {
      console.log(expected.join(''));
    }
    console.groupEnd();

    console.group(`actual`);
    {
      console.log(actual.join(''));
    }
    console.groupEnd();

    console.group(`diff`);
    {
      console.log(`// TODO: diff actual and expected`);
    }
    console.groupEnd();
  }
  console.groupEnd();

  return passed;
}
