// Browser-only JavaScript for ./index.html
// Non-browser-only sources are under src/

import {basicSetup} from "codemirror";
import {EditorView, keymap} from "@codemirror/view";
import {EditorState} from "@codemirror/state";
import {indentWithTab} from "@codemirror/commands";
import {javascript} from "@codemirror/lang-javascript";

import * as comehere from './src/comehere.mjs';

const sampleInput = `
// Computes an equation given numbers from HTML <input>s.
function aBuggyFunction(x, y, z) {
  // FIXME: The old version worked but looked odd!
  // Why doesn't it work now?

  let oldResult = ($$0 = + x + + y) * z; // OLD
  return              ($$1 = x + y) * z; // NEW

  // We capture intermediate results with $$0 and $$1
  // and then a COMEHERE block causes control to come
  // here so we don't have to synthesize a whole program
  // input that gets the values we want here.

  COMEHERE:with ("let's debug!",
                 x = '2', y = '4', z = '7') {
    // COMEHERE will synthesize a call to the
    // function so this code below gets called
    // with those values of x, y, and z.
    console.log(...$$0);
    console.log(...$$1);
    console.log('->', Function.return);
  }
}
`.trim();

let initialEditorContent = sampleInput;
const EDITOR_CONTENT_ITEM_NAME = 'editorContent';
try {
  let storedContent = globalThis.localStorage.getItem(
    EDITOR_CONTENT_ITEM_NAME
  );
  if (storedContent) {
    initialEditorContent = storedContent;
  }
} catch (e) {
  // fall back to sampleInput
}

globalThis.resetStoredContent = () => {
  globalThis.localStorage.setItem(
    EDITOR_CONTENT_ITEM_NAME,
    sampleInput
  );
  globalThis.location.reload();
};

let editorView = new EditorView({
  doc: initialEditorContent,
  extensions: [
    basicSetup,
    keymap.of([indentWithTab]),
    javascript(),
    EditorView.updateListener.of(
      update => {
        if (update.docChanged) {
          scheduleTranslation();
        }
      }
    ),
  ],
  parent: document.querySelector("#editor")
});

// Rate limit retranslation in case the user
// is typing fast.
const RETRANSLATE_LATENCY = 250; // ms
let retranslateTimer = null;
function scheduleTranslation() {
  if (retranslateTimer === null) {
    retranslateTimer = setTimeout(
      () => {
        retranslateTimer = null;
        retranslate();
      },
      RETRANSLATE_LATENCY,
    );
  }
}

// Highlights the adjusted JS
let translationView = new EditorView({
  doc: '',
  extensions: [
    basicSetup,
    javascript(),
    EditorState.readOnly.of(true),
    EditorView.lineWrapping,
  ],
  parent: document.querySelector("#translation")
});

let currentTranslation = null;
// Update the UI state based on the editor content.
// UI state includes:
// - the content of the translation codemirror
// - the <select> options that let the user choose a COMEHERE block
// - any error messages from translation in the console view
function retranslate() {
  let translatedCode;
  try {
    console.clear();
    let jsSource = editorView.state.doc.toString();
    // Save the source so that reloading the page will restore
    // the last translated version.
    globalThis.localStorage.setItem(
      EDITOR_CONTENT_ITEM_NAME, jsSource
    );
    currentTranslation = comehere.transform(jsSource);
    translatedCode = currentTranslation.code;
  } catch (e) {
    if (e.constructor.name === 'SyntaxError') { return }
    console.error(e);
    return;
  }
  translationView.dispatch(
    { changes: {from: 0, to: translationView.state.doc.length, insert: translatedCode} }
  );
  // TODO: maybe use codemirror.net/5/doc/manual.html#addon_merge to highlight
  // differences, ideally at a token level, between the input & the translation.

  // Update the select dropdown if the options changed
  if (currentTranslation) {
    let select = document.querySelector('#block-choice');
    let options = [...select.querySelectorAll('option')];
    let newOptions = [
      ...currentTranslation.blocks.map((x, i) => x || `Choice ${i + 1}`),
      'Seek nothing'
    ];
    let changed = options.length !== newOptions.length;
    if (!changed) {
      for (let i = 0, n = options.length; i < n; ++i) {
        if (options[i].textContent !== newOptions[i]) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      for (let option of options) {
        option.parentNode.removeChild(option);
      }
      for (let i = 0, n = newOptions.length; i < n; ++i) {
        // Seeking values are 1-indexed, but we have the
        // 'seek nothing' option at the end.
        let isSeekNothing = i == n - 1;
        let seekingValue = isSeekNothing ? 0 : i + 1;
        let newOptionNode = document.createElement('option');
        newOptionNode.value = `${seekingValue}`;
        newOptionNode.textContent = newOptions[i];
        select.appendChild(newOptionNode);
      }
    }
  }
}

// Override console to log to the console window as well.
let originalConsole = globalThis.console;
{
  let consoleWrapper = Object.create(originalConsole);

  let consoleView = document.querySelector('#console-output');

  let indent = 0;

  function emit(style, argsArray) {
    let box = document.createElement('div');
    let startsLine = true; // Suppress spaces before next value.
    for (let value of argsArray) {
      let text;
      switch (typeof value) {
        case 'string': text = value; break;
        case 'symbol': text = value.toString(); break;
        case 'undefined': text = 'undefined'; break;
        case 'object':
          try {
            text = value ? value.toString() : 'null';
          } catch {
            text = '<toString() failed>';
          }
          break;
        default: text = `${value}`; break;
      }
      if (!text) { continue }
      if (!startsLine) {
        let spacer = document.createElement('span');
        spacer.textContent = ' ';
        spacer.className = 'spacer';
        box.appendChild(spacer);
      }
      let span = document.createElement('span');
      box.appendChild(span);
      span.className = (typeof value === 'string')
        ? `text`
        : `value value-${typeof value}`;
      span.textContent = text;
      startsLine = /[\r\n]$/.test(text);
    }
    box.className = style;
    box.style.marginLeft = `${indent}em`;
    consoleView.append(box);
  }

  consoleWrapper.clear = function () {
    indent = 0;
    for (let child; child = consoleView.firstChild;) {
      consoleView.removeChild(child);
    }
  };
  consoleWrapper.group = function (...args) {
    originalConsole.group(...args);

    emit('group-head', args);
    indent += 1;
  };
  consoleWrapper.groupEnd = function (...args) {
    originalConsole.groupEnd(...args);
    if (indent) { indent -= 1; }
  };

  for (let outputMethod of ['log', 'info', 'warn', 'error']) {
    consoleWrapper[outputMethod] = function (...args) {
      originalConsole[outputMethod](...args);

      emit(outputMethod, args);
    };
  }
  globalThis.console = consoleWrapper;
  globalThis.onerror = (e) => { consoleWrapper.error(e) };
}

function getWhichSeeking(meta) {
  return +document.querySelector('#block-choice').value || 0;
}

globalThis.debugHooks = {
  getWhichSeeking,
};

function runCurrentTranslation() {
  console.clear();
  let code = currentTranslation.code;
  let choice = document.querySelector('#block-choice').selectedOptions[0]?.textContent || '';
  let choiceIndex = getWhichSeeking();
  let fullText = `
console.group('Running', ${JSON.stringify(choice)}, ${JSON.stringify(`#${choiceIndex}`)});

${code}

console.groupEnd();
`;
  let scriptNode = document.createElement('script');
  scriptNode.type = 'module';
  scriptNode.appendChild(document.createTextNode(fullText));
  document.body.appendChild(scriptNode);
}

document.querySelector('#play-button').onclick = runCurrentTranslation;

scheduleTranslation();

// Once the page has loaded, make the example scripts interactive by
// allowing replacing the editor content.
function setEditorContent(newContent) {
  editorView.dispatch(
    {
      changes: {
        from: 0,
        to: editorView.state.doc.length,
        insert: newContent
      }
    }
  );
}

function showScrollBackButton(target) {
  let scrollBackButton = document.querySelector('#scroll-back-button');
  let scrollBackButtonRow = document.querySelector('#scroll-back-button-row');
  scrollBackButton.onclick = () => {
    target.scrollIntoView();
  };
  scrollBackButtonRow.style.display = '';
}

{
  for (let example of document.querySelectorAll('table.example-display td.left')) {
    let text = example.textContent;
    let button = document.createElement('button');
    button.type = 'button';
    button.textContent = '\ud83d\udccb'; // Clipboard
    button.className = 'copy-button';
    button.title = 'copy to editor';
    example.insertBefore(button, example.firstChild);
    button.onclick = () => {
      setEditorContent(text);
      showScrollBackButton(example);
      document.querySelector('#editor-table').scrollIntoView();
    };
  }
}
