import * as types from '@babel/types';

/**
 * Looks at a babel path to an identifier and tells whether it
 */
export function isDeclared(identifierPath) {
  let {parentPath} = identifierPath;

  if (
    (parentPath.isVariableDeclarator()
     || parentPath.isDeclaration()
     || parentPath.isRestElement())
      && parentPath.get('id').node === identifierPath.node
  ) {
    return true;
  }
  if (parentPath.isArrayPattern()) {
    return true;
  }
  if (parentPath.isAssignmentPattern() && parentPath.node.left === identifierPath.node) {
    return true;
  }
  let parent = parentPath.node;
  if (parentPath.isFunction()) {
    let {params} = parent;
    for (let param of params) {
      if (param === identifierPath.node) {
        return true;
      }
    }
  }
  // Class members and object properties
  if (parent.key && parent.computed === false && parent.key === identifierPath.node) {
    return true;
  }
  return false;
}
