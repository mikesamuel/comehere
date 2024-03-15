import {basicSetup} from "codemirror";
import {EditorView, keymap} from "@codemirror/view";
import {EditorState} from "@codemirror/state";
import {indentWithTab} from "@codemirror/commands";
import {javascript} from "@codemirror/lang-javascript";

import * as comehere from './src/comehere.mjs';

const sampleInput = `
// Computes an equation given numbers from HTML <input>s.
function aBuggyFunction(x, y, z) {
  // let result = (+ x + + y) * z; // OLD
  let result = (x + y) * z;        // NEW
  // FIXME: The old version worked but looked odd!
  // Why doesn't it work now?
  COMEHERE: with ("let's debug!",
                  x = '2', y = '4', z = '7') {
    // COMEHERE will synthesize a call to the
    // function so this code below gets called
    // with those values of x, y, and z.
    console.log('x + y =', (x + y));
    console.log('+ x + + y =', (+ x + + y));
  }
  return result;
}
`.trim();

let editorView = new EditorView({
  doc: sampleInput,
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

  // Update the select dropdown if the options changed
  if (currentTranslation) {
    let select = document.querySelector('#block-choice');
    let options = [...select.querySelectorAll('option')];
    let newOptions = currentTranslation.blocks.map((x, i) => x || `Choice ${i + 1}`);
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
        let newOptionNode = document.createElement('option');
        newOptionNode.textContent = newOptions[i];
        newOptionNode.value = `${i + 1}`;
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
    for (let i = 0, n = argsArray.length; i < n; ++i) {
      if (i) {
        let spacer = document.createElement('span');
        spacer.textContent = ' ';
        spacer.className = 'spacer';
        box.appendChild(spacer);
      }
      let span = document.createElement('span');
      box.appendChild(span);
      let value = argsArray[i];
      span.className = (typeof value === 'string')
        ? `text`
        : `value value-${typeof value}`;
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
      span.textContent = text;
    }
    box.className = style;
    box.style.marginLeft = `${indent}em`;
    consoleView.append(box);
  }

  consoleWrapper.clear = function () {
    indent = 0;
    for (let child = consoleView.firstChild; child; child = child.nextSibling) {
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
