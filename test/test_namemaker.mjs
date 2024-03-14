import { expect, assert } from "chai";
import { describe, it } from "mocha";

import * as namemaker from "../src/name-maker.mjs";

import {parse} from '@babel/parser';

function strip12([s]) {
  return s.replace(/\n            /g, '\n')
    .replace(/^\n|\n$/g, '')
}

describe('name-maker', () => {
  it('making names', () => {
    let ast = parse(
      strip12`
            let i = 0;

            let o = { j: 32, j_0: 33, j_1: 34, j_2: 35 }; // These j's are not var names
            let o_1 = o;

            o.j_0; // j_0 can be made
            arr[j_1]; // j_1 cannot.

            function f(x, y) { return x; }
            function f_0(x_1, y_2) { return x_0; }

            let arr = [1, 2, 3];
            try {
              arr_1
            } catch(e) {
              fix();
            }
            `
    );

    let nameMaker = new namemaker.NameMaker(namemaker.namesUsedIn(ast));
    let unused = (prefix) => nameMaker.unusedName(prefix);

    expect(['i_0', 'i_1', 'i_2'])
      .deep.equals([unused('i'), unused('i'), unused('i')]);

    expect(['j_0', /*'j_1',*/ 'j_2', 'j_3'])
      .deep.equals([unused('j'), unused('j'), unused('j')]);

    expect([/*'f_0',*/ 'f_1', 'f_2', 'f_3'])
      .deep.equals([unused('f'), unused('f'), unused('f')]);

    expect(['arr_0', /*, 'arr_1'*/ 'arr_2', 'arr_3'])
      .deep.equals([unused('arr'), unused('arr'), unused('arr')]);

    expect(['o_0', /*'o_1',*/ 'o_2', 'o_3'])
      .deep.equals([unused('o'), unused('o'), unused('o')]);

    expect([/*'x_0',*/ /*'x_1',*/ 'x_2', 'x_3', 'x_4'])
      .deep.equals([unused('x'), unused('x'), unused('x')]);

    expect(['y_0', 'y_1', /*'y_2',*/ 'y_3'])
      .deep.equals([unused('y'), unused('y'), unused('y')]);
  });
});
