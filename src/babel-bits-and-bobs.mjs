// Split the difference between node's ESM integration and the normal kind.
import generateDefault from '@babel/generator';
import traverseDefault from '@babel/traverse';
export let traverse = (typeof traverseDefault === 'function')
  ? traverseDefault
  : traverseDefault.default;
export let generate = (typeof generateDefault === 'function')
  ? generateDefault
  : generateDefault.default;
