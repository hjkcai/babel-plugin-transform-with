export default function ({template, traverse, types: t}) {
  const buildParamDef = template(`
    STRING in LOCAL ?
      LOCAL.NAME :
      typeof NAME !== "undefined" ?
        NAME :
        undefined
  `);

  let buildRetCheck = template(`
    if (typeof RETURN === "object") return RETURN.v;
  `);

  const loopLabelVisitor = {
    LabeledStatement({node}, state) {
      state.innerLabels.push(node.label.name);
    }
  };

  const globalsVisitor = {
    AssignmentExpression(path, {globals, builtin}) {
      for (let name in path.getBindingIdentifiers()) {
        if (!path.scope.hasBinding(name, !builtin)) {
          globals[name] = true;
        }
      }
    },

    ReferencedIdentifier({node, scope}, {globals, builtin}) {
      if (!scope.hasBinding(node.name, !builtin)) {
        globals[node.name] = true;
      }
    }
  };

  function getGlobals(path, builtin) {
    const state = {
      globals: {},
      builtin
    };
    // path.traverse doesn't actually traverse the path.node itself
    // for some reason
    path.scope.traverse(path.node, globalsVisitor, state);
    return state.globals;
  }

  function loopNodeTo(node) {
    if (t.isBreakStatement(node)) {
      return "break";
    } else if (t.isContinueStatement(node)) {
      return "continue";
    }
  }

  const withBodyVisitor = {
    Loop(path, state) {
      let oldIgnoreLabeless = state.ignoreLabeless;
      state.ignoreLabeless = true;
      path.traverse(withBodyVisitor, state);
      state.ignoreLabeless = oldIgnoreLabeless;
      path.skip();
    },

    Function(path, state) {
      path.skip();
    },

    SwitchCase(path, state) {
      let oldInSwitchCase = state.inSwitchCase;
      state.inSwitchCase = true;
      path.traverse(withBodyVisitor, state);
      state.inSwitchCase = oldInSwitchCase;
      path.skip();
    },

    'BreakStatement|ContinueStatement|ReturnStatement'(path, state) {
      let {node, scope} = path;
      if (node[this.LOOP_IGNORE]) return;

      let replace;
      let loopText = loopNodeTo(node);

      if (loopText) {
        if (node.label) {
          // we shouldn't be transforming this because it exists somewhere inside
          if (state.innerLabels.indexOf(node.label.name) >= 0) {
            return;
          }

          loopText = `${loopText}|${node.label.name}`;
        } else {
          // we shouldn't be transforming these statements because
          // they don't refer to the actual loop we're scopifying
          if (state.ignoreLabeless) return;
          if (state.inSwitchCase) return;

          if (t.isBreakStatement(node)) {
            const parent = path.findParent(path => path.isLoop() || path.isSwitchStatement());

            // Prevent possible ambiguity later with switch statements.
            // Find parent's label (or add one if there isn't one), and make
            //   the break go to that label.
            let label;
            if (parent.parentPath.isLabeledStatement()) {
              label = parent.parent.label;
            } else {
              label = parent.scope.generateUidIdentifier('outer');
              parent.replaceWith(t.labeledStatement(label, parent.node));
            }
            node.label = label;
            loopText = `${loopText}|${node.label.name}`;
          }
        }

        state.hasBreakContinue = true;
        state.map[loopText] = node;
        replace = t.stringLiteral(loopText);
      }

      if (path.isReturnStatement()) {
        state.hasReturn = true;
        replace = t.objectExpression([
          t.objectProperty(t.identifier("v"), node.argument || scope.buildUndefinedNode())
        ]);
      }

      if (replace) {
        replace = t.returnStatement(replace);
        replace[this.LOOP_IGNORE] = true;
        path.skip();
        path.replaceWith(t.inherits(replace, node));
      }
    }
  };

  return {
    visitor: {
      BlockStatement(path) {
        const {node} = path;
        if (checkComment()) {
          const obj = getExpression();
          path.replaceWith(t.withStatement(obj, node));
        }

        function checkComment() {
          if (node.leadingComments && node.leadingComments.length) {
            let comment = node.leadingComments.pop();
            if (comment.value.trim() !== '@with') {
              node.leadingComments.push(comment);
              return false;
            }

            let prev = path.getSibling(path.key - 1);
            if (prev.node && prev.node.trailingComments && prev.node.trailingComments.length) {
              prev.node.trailingComments.pop();
            }

            return true;
          }
          return false;
        }

        function getExpression() {
          const objPath = path.get('body.0');
          if (!objPath || !objPath.isExpressionStatement()) {
            (objPath || path).buildCodeFrameError('A @with block must have an expression as its first statement.');
          }
          const {node} = objPath;
          objPath.remove();
          return node.expression;
        }
      },

      WithStatement: {
        exit(path, {
          opts: {
            exclude = [],
            builtin = false
          }
        }) {
          path.ensureBlock();

          const {node, scope} = path;
          const obj = path.get('object');
          const srcBody = path.get('body');

          // No body
          if (!srcBody || !srcBody.node.body.length) {
            if (obj.isPure()) {
              path.remove();
            } else {
              path.replaceWith(obj.node);
            }
            return;
          }

          let state = {
            globals: {}
          };

          srcBody.traverse(globalsVisitor, state);

          exclude = exclude.concat(Object.keys(getGlobals(obj, builtin)), ['undefined']);
          const vars = Object.keys(state.globals).filter(function (v) {
            return exclude.indexOf(v) === -1;
          });

          // No globals -> no processing needed
          if (!vars.length) {
            const body = [srcBody.node];
            // If the object has
            if (!obj.isPure()) {
              body.unshift(t.expressionStatement(obj.node));
            }
            path.replaceWithMultiple(body);
            return;
          }

          state = {
            hasBreakContinue: false,
            ignoreLabeless: false,
            inSwitchCase: false,
            innerLabels: [],
            hasReturn: false,
            // Map of breaks and continues. Key is the returned value, value is
            // the node corresponding to the break/continue.
            map: {},
            LOOP_IGNORE: Symbol()
          };

          srcBody.traverse(loopLabelVisitor, state);
          srcBody.traverse(withBodyVisitor, state);

          const body = [];

          // Determine if the local variable can be used directly, or if
          // a temporary variable has to be used
          let local = obj.node;
          if (!t.isIdentifier(local)) {
            local = scope.generateUidIdentifier('local');
            body.push(t.variableDeclaration('var', [
              t.variableDeclarator(local, obj.node)
            ]));
          }

          // Build the main function
          const fn = t.functionExpression(null, vars.map(function (v) {
            return t.identifier(v);
          }), srcBody.node);
          // Inherits the `this` from the parent scope
          fn.shadow = true;

          // Build the main function call
          const call = t.callExpression(fn, vars.map(function (v) {
            return buildParamDef({
              STRING: t.stringLiteral(v),
              NAME: t.identifier(v),
              LOCAL: local
            }).expression;
          }));

          if (state.hasReturn || state.hasBreakContinue) {
            // If necessary, make sure returns, breaks, and continues are
            // handled.

            // Store returned value in a _ret variable.
            const ret = scope.generateUidIdentifier('ret');
            body.push(t.variableDeclaration('var', [
              t.variableDeclarator(ret, call)
            ]));

            // If there are returns in the body, an object of form {v: value}
            //   will be returned.
            // If `break` and `continue` present in the body with a specified
            //   label, `${keyword}|${label}` will be returned. If not, the
            //   keyword is returned directly.
            // Use a switch-case construct to differentiate between different
            //   return modes. `cases` stores all the individual SwitchCases.
            //   Breaks and continues will be regular cases, while returns are
            //   in `default` and further checked.
            const cases = [];

            const retCheck = buildRetCheck({
              RETURN: ret
            });

            if (state.hasBreakContinue) {
              for (let key in state.map) {
                cases.push(t.switchCase(t.stringLiteral(key), [state.map[key]]));
              }

              if (state.hasReturn) {
                cases.push(t.switchCase(null, [retCheck]));
              }

              // Optimize the "case" where there is only one case.
              if (cases.length === 1) {
                const single = cases[0];
                body.push(t.ifStatement(
                  t.binaryExpression('===', ret, single.test),
                  single.consequent[0]
                ));
              } else {
                body.push(t.switchStatement(ret, cases));
              }
            } else {
              if (state.hasReturn) {
                body.push(retCheck);
              }
            }
          } else {
            // No returns, breaks, or continues. Just push the call itself.
            body.push(t.expressionStatement(call));
          }

          path.replaceWithMultiple(body);
        }
      }
    }
  };
}