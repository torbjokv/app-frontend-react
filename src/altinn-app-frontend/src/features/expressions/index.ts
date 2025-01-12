import dot from 'dot-object';
import type { Mutable } from 'utility-types';

import {
  ExprRuntimeError,
  LookupNotFound,
  NodeNotFoundWithoutContext,
  UnexpectedType,
  UnknownSourceType,
  UnknownTargetType,
} from 'src/features/expressions/errors';
import { ExprContext } from 'src/features/expressions/ExprContext';
import {
  addError,
  asExpression,
  canBeExpression,
} from 'src/features/expressions/validation';
import { LayoutNode } from 'src/utils/layout/hierarchy';
import type { ContextDataSources } from 'src/features/expressions/ExprContext';
import type {
  BaseToActual,
  BaseValue,
  ExprDefaultValues,
  Expression,
  ExprFunction,
  ExprResolved,
  FuncDef,
} from 'src/features/expressions/types';
import type { ILayoutComponent, ILayoutGroup } from 'src/features/form/layout';
import type { LayoutRootNode } from 'src/utils/layout/hierarchy';

import type { IInstanceContext } from 'altinn-shared/types';

export interface EvalExprOptions {
  defaultValue?: any;
  errorIntroText?: string;
}

export interface EvalExprInObjArgs<T> {
  input: T;
  node: LayoutNode<any> | NodeNotFoundWithoutContext;
  dataSources: ContextDataSources;
  defaults?: ExprDefaultValues<T>;
}

/**
 * This function is the brains behind the useExpressions() hook, as it will find any expressions inside a deep
 * object and resolve them.
 * @see useExpressions
 */
export function evalExprInObj<T>(args: EvalExprInObjArgs<T>): ExprResolved<T> {
  if (!args.input) {
    return args.input as ExprResolved<T>;
  }

  return evalExprInObjectRecursive(
    args.input,
    args as Omit<EvalExprInObjArgs<T>, 'input'>,
    [],
  );
}

/**
 * Recurse through an input object/array/any, finds expressions and evaluates them
 */
function evalExprInObjectRecursive<T>(
  input: any,
  args: Omit<EvalExprInObjArgs<T>, 'input'>,
  path: string[],
) {
  if (typeof input !== 'object') {
    return input;
  }

  if (Array.isArray(input)) {
    let evaluateAsExpression = false;
    if (args.defaults) {
      const pathString = path.join('.');
      const defaultValue = dot.pick(pathString, args.defaults);
      evaluateAsExpression = typeof defaultValue !== 'undefined';
    } else if (canBeExpression(input)) {
      evaluateAsExpression = true;
    }

    if (evaluateAsExpression) {
      const expression = asExpression(input);
      if (expression) {
        return evalExprInObjectCaller(expression, args, path);
      }
    }

    const newPath = [...path];
    const lastLeg = newPath.pop() || '';
    return input.map((item, idx) =>
      evalExprInObjectRecursive(item, args, [...newPath, `${lastLeg}[${idx}]`]),
    );
  }

  const out = {};
  for (const key of Object.keys(input)) {
    out[key] = evalExprInObjectRecursive(input[key], args, [...path, key]);
  }

  return out;
}

/**
 * Extracted function for evaluating expressions in the context of a larger object
 */
function evalExprInObjectCaller<T>(
  expr: Expression,
  args: Omit<EvalExprInObjArgs<T>, 'input'>,
  path: string[],
) {
  const pathString = path.join('.');
  const nodeId =
    args.node instanceof NodeNotFoundWithoutContext
      ? args.node.nodeId
      : args.node.item.id;

  const exprOptions: EvalExprOptions = {
    errorIntroText: `Evaluated expression for '${pathString}' in component '${nodeId}'`,
  };

  if (args.defaults) {
    const defaultValue = dot.pick(pathString, args.defaults);
    if (typeof defaultValue !== 'undefined') {
      exprOptions.defaultValue = defaultValue;
    }
  }

  return evalExpr(expr, args.node, args.dataSources, exprOptions);
}

/**
 * Run/evaluate an expression. You have to provide your own context containing functions for looking up external
 * values. If you need a more concrete implementation:
 * @see evalExprInObj
 * @see useExpressions
 */
export function evalExpr(
  expr: Expression,
  node: LayoutNode<any> | LayoutRootNode<any> | NodeNotFoundWithoutContext,
  dataSources: ContextDataSources,
  options?: EvalExprOptions,
) {
  let ctx = ExprContext.withBlankPath(expr, node, dataSources);
  try {
    const result = innerEvalExpr(ctx);
    if (
      (result === null || result === undefined) &&
      options &&
      'defaultValue' in options
    ) {
      return options.defaultValue;
    }

    return result;
  } catch (err) {
    if (err instanceof ExprRuntimeError) {
      ctx = err.context;
    } else {
      throw err;
    }
    if (options && 'defaultValue' in options) {
      // When we know of a default value, we can safely print it as an error to the console and safely recover
      ctx.trace(err, {
        defaultValue: options.defaultValue,
        ...(options.errorIntroText
          ? { introText: options.errorIntroText }
          : {}),
      });
      return options.defaultValue;
    } else {
      // We cannot possibly know the expected default value here, so there are no safe ways to fail here except
      // throwing the exception to let everyone know we failed.
      throw new Error(ctx.prettyError(err));
    }
  }
}

export function argTypeAt(
  func: ExprFunction,
  argIndex: number,
): BaseValue | undefined {
  const funcDef = ExprFunctions[func];
  const possibleArgs = funcDef.args;
  const maybeReturn = possibleArgs[argIndex];
  if (maybeReturn) {
    return maybeReturn;
  }

  if (funcDef.lastArgSpreads) {
    return possibleArgs[possibleArgs.length - 1];
  }

  return undefined;
}

function innerEvalExpr(context: ExprContext) {
  const [func, ...args] = context.getExpr();

  const returnType = ExprFunctions[func].returns;
  const neverCastIndexes = new Set(
    ExprFunctions[func].neverCastArguments || [],
  );

  const computedArgs = args.map((arg, idx) => {
    const realIdx = idx + 1;
    const argContext = ExprContext.withPath(context, [
      ...context.path,
      `[${realIdx}]`,
    ]);

    const argValue = Array.isArray(arg) ? innerEvalExpr(argContext) : arg;
    if (neverCastIndexes.has(idx)) {
      return argValue;
    }

    const argType = argTypeAt(func, idx);
    return castValue(argValue, argType, argContext);
  });

  const actualFunc: (...args: any) => any = ExprFunctions[func].impl;
  const returnValue = actualFunc.apply(context, computedArgs);

  if (ExprFunctions[func].castReturnValue === false) {
    return returnValue;
  }

  return castValue(returnValue, returnType, context);
}

function valueToBaseValueType(value: any): BaseValue | string {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return 'number';
  }
  return typeof value;
}

function isLikeNull(arg: any) {
  return arg === 'null' || arg === null || typeof arg === 'undefined';
}

/**
 * This function is used to cast any value to a target type before/after it is passed
 * through a function call.
 */
function castValue<T extends BaseValue>(
  value: any,
  toType: T,
  context: ExprContext,
): BaseToActual<T> {
  if (!(toType in ExprTypes)) {
    throw new UnknownTargetType(this, toType);
  }

  const typeObj = ExprTypes[toType];

  if (typeObj.nullable && isLikeNull(value)) {
    return null;
  }

  const valueBaseType = valueToBaseValueType(value) as BaseValue;
  if (!typeObj.accepts.includes(valueBaseType)) {
    const supported = [
      ...typeObj.accepts,
      ...(typeObj.nullable ? ['null'] : []),
    ].join(', ');
    throw new UnknownSourceType(this, typeof value, supported);
  }

  return typeObj.impl.apply(context, [value]);
}

function defineFunc<Args extends readonly BaseValue[], Ret extends BaseValue>(
  def: FuncDef<Args, Ret>,
): FuncDef<Mutable<Args>, Ret> {
  return def;
}

const instanceContextKeys: { [key in keyof IInstanceContext]: true } = {
  instanceId: true,
  appId: true,
  instanceOwnerPartyId: true,
};

/**
 * All the functions available to execute inside expressions
 */
export const ExprFunctions = {
  equals: defineFunc({
    impl: (arg1, arg2) => arg1 === arg2,
    args: ['string', 'string'] as const,
    returns: 'boolean',
  }),
  notEquals: defineFunc({
    impl: (arg1, arg2) => arg1 !== arg2,
    args: ['string', 'string'] as const,
    returns: 'boolean',
  }),
  greaterThan: defineFunc({
    impl: (arg1, arg2) => {
      if (arg1 === null || arg2 === null) {
        return false;
      }

      return arg1 > arg2;
    },
    args: ['number', 'number'] as const,
    returns: 'boolean',
  }),
  greaterThanEq: defineFunc({
    impl: (arg1, arg2) => {
      if (arg1 === null || arg2 === null) {
        return false;
      }

      return arg1 >= arg2;
    },
    args: ['number', 'number'] as const,
    returns: 'boolean',
  }),
  lessThan: defineFunc({
    impl: (arg1, arg2) => {
      if (arg1 === null || arg2 === null) {
        return false;
      }

      return arg1 < arg2;
    },
    args: ['number', 'number'] as const,
    returns: 'boolean',
  }),
  lessThanEq: defineFunc({
    impl: (arg1, arg2) => {
      if (arg1 === null || arg2 === null) {
        return false;
      }

      return arg1 <= arg2;
    },
    args: ['number', 'number'] as const,
    returns: 'boolean',
  }),
  concat: defineFunc({
    impl: (...args) => args.join(''),
    args: ['string'],
    minArguments: 0,
    returns: 'string',
    lastArgSpreads: true,
  }),
  and: defineFunc({
    impl: (...args) => args.reduce((prev, cur) => !!prev && !!cur, true),
    args: ['boolean'],
    returns: 'boolean',
    lastArgSpreads: true,
  }),
  or: defineFunc({
    impl: (...args) => args.reduce((prev, cur) => !!prev || !!cur, false),
    args: ['boolean'],
    returns: 'boolean',
    lastArgSpreads: true,
  }),
  if: defineFunc({
    impl: function (...args) {
      const [condition, result] = args;
      if (condition === 'true') {
        return result;
      }

      return args.length === 4 ? args[3] : null;
    },
    validator: ({ rawArgs, ctx, path }) => {
      if (rawArgs.length === 2) {
        return;
      }
      if (rawArgs.length > 2 && rawArgs[2] !== 'else') {
        addError(ctx, [...path, '[2]'], 'Expected third argument to be "else"');
      }
      if (rawArgs.length === 4) {
        return;
      }
      addError(
        ctx,
        path,
        'Expected either 2 arguments (if) or 4 (if + else), got %s',
        `${rawArgs.length}`,
      );
    },
    args: ['string', 'string'],
    returns: 'string',
    lastArgSpreads: true,
    neverCastArguments: [1, 3],
    castReturnValue: false,
  }),
  instanceContext: defineFunc({
    impl: function (key) {
      if (instanceContextKeys[key] !== true) {
        throw new LookupNotFound(
          this,
          `Unknown Instance context property ${key}`,
        );
      }

      return this.dataSources.instanceContext[key];
    },
    args: ['string'] as const,
    returns: 'string',
  }),
  frontendSettings: defineFunc({
    impl: function (key) {
      return this.dataSources.applicationSettings[key];
    },
    args: ['string'] as const,
    returns: 'string',
  }),
  component: defineFunc({
    impl: function (id): string {
      const component = this.failWithoutNode().closest(
        (c) => c.id === id || c.baseComponentId === id,
      );
      if (
        component &&
        component.item.dataModelBindings &&
        component.item.dataModelBindings.simpleBinding
      ) {
        return this.dataSources.formData[
          component.item.dataModelBindings.simpleBinding
        ];
      }

      throw new LookupNotFound(
        this,
        `Unable to find component with identifier ${id} or it does not have a simpleBinding`,
      );
    },
    args: ['string'] as const,
    returns: 'string',
  }),
  dataModel: defineFunc({
    impl: function (path): string {
      const maybeNode = this.failWithoutNode();
      if (maybeNode instanceof LayoutNode) {
        const newPath = maybeNode.transposeDataModel(path);
        return this.dataSources.formData[newPath] || null;
      }

      // No need to transpose the data model according to the location inside a repeating group when the context is
      // a LayoutRootNode (i.e., when we're resolving an expression directly on the layout definition).
      return this.dataSources.formData[path] || null;
    },
    args: ['string'] as const,
    returns: 'string',
  }),
};

function asNumber(arg: string) {
  if (arg.match(/^-?\d+$/)) {
    return parseInt(arg, 10);
  }
  if (arg.match(/^-?\d+\.\d+$/)) {
    return parseFloat(arg);
  }

  return undefined;
}

/**
 * All the types available in expressions, along with functions to cast possible values to them
 * @see castValue
 */
export const ExprTypes: {
  [Type in BaseValue]: {
    nullable: boolean;
    accepts: BaseValue[];
    impl: (this: ExprContext, arg: any) => BaseToActual<Type>;
  };
} = {
  boolean: {
    nullable: true,
    accepts: ['boolean', 'string', 'number'],
    impl: function (arg) {
      if (typeof arg === 'boolean') {
        return arg;
      }
      if (arg === 'true') return true;
      if (arg === 'false') return false;

      if (
        typeof arg === 'string' ||
        typeof arg === 'number' ||
        typeof arg === 'bigint'
      ) {
        const num = typeof arg === 'string' ? asNumber(arg) : arg;
        if (num !== undefined) {
          if (num === 1) return true;
          if (num === 0) return false;
        }
      }

      throw new UnexpectedType(this, 'boolean', arg);
    },
  },
  string: {
    nullable: true,
    accepts: ['boolean', 'string', 'number'],
    impl: function (arg) {
      if (['number', 'bigint', 'boolean'].includes(typeof arg)) {
        return JSON.stringify(arg);
      }

      // Always lowercase these values, to make comparisons case-insensitive
      if (arg.toLowerCase() === 'null') return null;
      if (arg.toLowerCase() === 'false') return 'false';
      if (arg.toLowerCase() === 'true') return 'true';

      return `${arg}`;
    },
  },
  number: {
    nullable: true,
    accepts: ['boolean', 'string', 'number'],
    impl: function (arg) {
      if (typeof arg === 'number' || typeof arg === 'bigint') {
        return arg as number;
      }
      if (typeof arg === 'string') {
        const num = asNumber(arg);
        if (num !== undefined) {
          return num;
        }
      }

      throw new UnexpectedType(this, 'number', arg);
    },
  },
};

export const ExprDefaultsForComponent: ExprDefaultValues<ILayoutComponent> = {
  readOnly: false,
  required: false,
  hidden: false,
};

export const ExprDefaultsForGroup: ExprDefaultValues<ILayoutGroup> = {
  ...ExprDefaultsForComponent,
  edit: {
    addButton: true,
    deleteButton: true,
    saveButton: true,
    alertOnDelete: false,
    saveAndNextButton: false,
  },
};
