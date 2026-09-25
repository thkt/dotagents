// Adapted from https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src/rules/no-reduce-accumulator-copy.ts
// and https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src/shared/array-method.ts (MIT; see LICENSE).
import { definePlugin, defineRule } from '@oxlint/plugins';
import type { ESTree, Scope, SourceCode, Variable } from '@oxlint/plugins';

function unwrapArrayExpression(node: ESTree.Node): ESTree.Node {
  while (
    node.type === 'ParenthesizedExpression' ||
    node.type === 'ChainExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSTypeAssertion' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TSSatisfiesExpression'
  ) {
    node = node.expression;
  }
  return node;
}

function resolveArrayBinding(sourceCode: SourceCode, node: ESTree.Node): Variable | null {
  node = unwrapArrayExpression(node);
  if (node.type !== 'Identifier') {
    return null;
  }
  let scope: Scope | null = sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.set.get(node.name);
    if (variable !== undefined) {
      return variable;
    }
    scope = scope.upper;
  }
  return null;
}

function arrayMethodTarget(
  node: ESTree.Node,
): { readonly name: string; readonly object: ESTree.Node } | null {
  node = unwrapArrayExpression(node);
  if (node.type !== 'MemberExpression') {
    return null;
  }
  const property = node.property;
  if (!node.computed && property.type === 'Identifier') {
    return { name: property.name, object: node.object };
  }
  if (node.computed && property.type === 'Literal' && typeof property.value === 'string') {
    return { name: property.value, object: node.object };
  }
  return null;
}

function getConstInitializer(variable: Variable): ESTree.Node | null {
  for (const definition of variable.defs) {
    if (
      definition.type === 'Variable' &&
      definition.node.type === 'VariableDeclarator' &&
      definition.node.id.type === 'Identifier' &&
      definition.node.init !== null &&
      definition.node.parent.type === 'VariableDeclaration' &&
      definition.node.parent.kind === 'const'
    ) {
      return definition.node.init;
    }
  }
  return null;
}

function isArrayAnnotation(type: ESTree.TSType): boolean {
  if (type.type === 'TSArrayType' || type.type === 'TSTupleType') {
    return true;
  }
  if (type.type === 'TSParenthesizedType') {
    return isArrayAnnotation(type.typeAnnotation);
  }
  if (type.type === 'TSTypeOperator' && type.operator === 'readonly') {
    return isArrayAnnotation(type.typeAnnotation);
  }
  return (
    type.type === 'TSTypeReference' &&
    type.typeName.type === 'Identifier' &&
    (type.typeName.name === 'Array' || type.typeName.name === 'ReadonlyArray')
  );
}

/** Recognize local array evidence; unknown receivers and iterator pipelines are deliberately excluded. */
function isKnownArrayExpression(
  sourceCode: SourceCode,
  node: ESTree.Node,
  visited = new Set<Variable>(),
): boolean {
  node = unwrapArrayExpression(node);
  if (node.type === 'ArrayExpression') {
    return true;
  }
  if (node.type === 'CallExpression') {
    const method = arrayMethodTarget(node.callee);
    return (
      method !== null &&
      [
        'map',
        'filter',
        'flatMap',
        'slice',
        'concat',
        'toSorted',
        'toReversed',
        'toSpliced',
      ].includes(method.name) &&
      isKnownArrayExpression(sourceCode, method.object, visited)
    );
  }
  if (node.type !== 'Identifier') {
    return false;
  }
  const variable = resolveArrayBinding(sourceCode, node);
  if (variable === null || visited.has(variable)) {
    return false;
  }
  visited.add(variable);
  if (variable.references.some((reference) => reference.isWrite() && !reference.init)) {
    return false;
  }
  for (const identifier of variable.identifiers) {
    const annotation = identifier.typeAnnotation?.typeAnnotation;
    if (annotation !== undefined) {
      return isArrayAnnotation(annotation);
    }
  }
  const initializer = getConstInitializer(variable);
  return initializer !== null && isKnownArrayExpression(sourceCode, initializer, visited);
}

function enclosingReducer(node: ESTree.Node) {
  let parent = node.parent;
  while (parent !== null) {
    if (parent.type === 'FunctionDeclaration') {
      return null;
    }
    if (parent.type === 'ArrowFunctionExpression' || parent.type === 'FunctionExpression') {
      return reducerForCallback(parent);
    }
    parent = parent.parent;
  }
  return null;
}

function reducerForCallback(callback: ESTree.ArrowFunctionExpression | ESTree.Function) {
  let owner: ESTree.Node | null = callback.parent;
  while (owner !== null && unwrapArrayExpression(owner) === callback) {
    owner = owner.parent;
  }
  if (owner?.type !== 'CallExpression') {
    return null;
  }
  const method = arrayMethodTarget(owner.callee);
  const firstArgument = owner.arguments[0];
  if (
    method === null ||
    (method.name !== 'reduce' && method.name !== 'reduceRight') ||
    owner.arguments.length > 2 ||
    firstArgument === undefined ||
    unwrapArrayExpression(firstArgument) !== callback
  ) {
    return null;
  }
  const firstParameter = callback.params[0];
  const accumulator =
    firstParameter?.type === 'AssignmentPattern' ? firstParameter.left : firstParameter;
  if (accumulator?.type !== 'Identifier') {
    return null;
  }
  return { callback, accumulator, initialValue: owner.arguments[1] };
}

function isWithin(node: ESTree.Node, ancestor: ESTree.Node): boolean {
  let current: ESTree.Node | null = node;
  while (current !== null) {
    if (current === ancestor) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function writesBeforeRead(write: ESTree.Node, read: ESTree.Node): boolean {
  if (write.start >= read.start) {
    return false;
  }
  let parent = write.parent;
  while (parent !== null) {
    if (
      parent.type === 'AssignmentExpression' &&
      isWithin(write, parent.left) &&
      isWithin(read, parent.right)
    ) {
      return false;
    }
    parent = parent.parent;
  }
  return true;
}

function referencesAccumulator(
  sourceCode: SourceCode,
  node: ESTree.Node,
  accumulator: Variable,
  visited = new Set<Variable>(),
): boolean {
  const variable = resolveArrayBinding(sourceCode, node);
  if (variable === null || visited.has(variable)) {
    return false;
  }
  if (variable === accumulator) {
    return !variable.references.some(
      (reference) =>
        reference.isWrite() && !reference.init && writesBeforeRead(reference.identifier, node),
    );
  }
  visited.add(variable);
  if (variable.references.some((reference) => reference.isWrite() && !reference.init)) {
    return false;
  }
  const initializer = getConstInitializer(variable);
  return (
    initializer !== null && referencesAccumulator(sourceCode, initializer, accumulator, visited)
  );
}

function isGlobalCopyOwner(sourceCode: SourceCode, node: ESTree.Node, name: string): boolean {
  node = unwrapArrayExpression(node);
  if (node.type !== 'Identifier' || node.name !== name) {
    return false;
  }
  const variable = resolveArrayBinding(sourceCode, node);
  return variable === null || variable.defs.length === 0;
}

function copiesReducerAccumulator(
  sourceCode: SourceCode,
  node: ESTree.CallExpression,
  method: { name: string; object: ESTree.Node },
  initialValue: ESTree.Node | undefined,
  isAccumulator: (expression: ESTree.Node) => boolean,
): boolean {
  if (method.name === 'assign' && isGlobalCopyOwner(sourceCode, method.object, 'Object')) {
    const target = node.arguments[0];
    return (
      target !== undefined &&
      unwrapArrayExpression(target).type === 'ObjectExpression' &&
      node.arguments.slice(1).some(isAccumulator)
    );
  }
  if (method.name === 'from' && isGlobalCopyOwner(sourceCode, method.object, 'Array')) {
    const source = node.arguments[0];
    return source !== undefined && isAccumulator(source);
  }
  return (
    ['concat', 'slice', 'toSpliced', 'toSorted', 'toReversed', 'with'].includes(method.name) &&
    initialValue !== undefined &&
    isKnownArrayExpression(sourceCode, initialValue) &&
    isAccumulator(method.object)
  );
}

/** Reject non-spread copies of reducer accumulators; pair with oxc/no-accumulating-spread. */
const noReduceAccumulatorCopyRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow copying growing reducer accumulators with Object.assign, Array.from, or array copy methods.',
    },
    messages: {
      accumulatorCopy:
        'Do not copy the reducer accumulator on every iteration; growing copies can cause quadratic work. Mutate a fresh, locally owned accumulator and return it, or use an iterator pipeline/flatMap.',
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const method = arrayMethodTarget(node.callee);
        if (method === null) {
          return;
        }
        const reducer = enclosingReducer(node);
        if (reducer === null) {
          return;
        }
        const accumulator = context.sourceCode
          .getDeclaredVariables(reducer.callback)
          .find((variable) =>
            variable.identifiers.some(
              (identifier) => identifier.start === reducer.accumulator.start,
            ),
          );
        if (accumulator === undefined) {
          return;
        }
        const isAccumulator = (expression: ESTree.Node) =>
          referencesAccumulator(context.sourceCode, expression, accumulator);
        const copiesAccumulator = copiesReducerAccumulator(
          context.sourceCode,
          node,
          method,
          reducer.initialValue,
          isAccumulator,
        );
        if (copiesAccumulator) {
          context.report({ node, messageId: 'accumulatorCopy' });
        }
      },
    };
  },
});

export default definePlugin({
  meta: { name: 'local' },
  rules: { 'no-reduce-accumulator-copy': noReduceAccumulatorCopyRule },
});
