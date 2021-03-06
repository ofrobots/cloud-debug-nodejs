/**
 * Copyright 2014 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as lodash from 'lodash';
import * as util from 'util';
import * as vm from 'vm';

import {debugAssert} from './debug-assert';

const transform = lodash.transform;
const flatten = lodash.flatten;
const isEmpty = lodash.isEmpty;

import {StatusMessage} from '../status-message';

import * as v8Types from '../types/v8-types';
import * as apiTypes from '../types/api-types';
import {DebugAgentConfig} from './config';

// TODO: Determine if `ScopeType` should be named `scopeType`.
// tslint:disable-next-line:variable-name
const ScopeType = vm.runInDebugContext('ScopeType');
const assert = debugAssert(process.env.CLOUD_DEBUG_ASSERTIONS);

// Error message indices into the resolved variable table.
const BUFFER_FULL_MESSAGE_INDEX = 0;
const NATIVE_PROPERTY_MESSAGE_INDEX = 1;
const GETTER_MESSAGE_INDEX = 2;
const ARG_LOCAL_LIMIT_MESSAGE_INDEX = 3;

/**
 * Captures the stack and current execution state.
 *
 * @return an object with stackFrames, variableTable, and
 *         evaluatedExpressions fields
 */
export function capture(
    execState: v8Types.ExecutionState, expressions: string[],
    config: DebugAgentConfig, v8: v8Types.Debug): apiTypes.Breakpoint {
  return (new StateResolver(execState, expressions, config, v8)).capture_();
}


/**
 * Checks that the provided expressions will not have side effects and
 * then evaluates the expression in the current execution context.
 *
 * @return an object with error and mirror fields.
 */
export function evaluate(expression: string, frame: v8Types.FrameMirror):
    {error: string | null, mirror?: v8Types.ValueMirror} {
  // First validate the expression to make sure it doesn't mutate state
  const acorn = require('acorn');
  try {
    const ast = acorn.parse(expression, {sourceType: 'script'});
    const validator = require('./validator');
    if (!validator.isValid(ast)) {
      return {error: 'expression not allowed'};
    }
  } catch (err) {
    return {error: err.message};
  }

  // Now actually ask V8 to evaluate the expression
  try {
    const mirror = frame.evaluate(expression);
    return {error: null, mirror: mirror};
  } catch (error) {
    return {error: error};
  }
}

class StateResolver {
  private state_: v8Types.ExecutionState;
  private expressions_: string[];
  private config_: DebugAgentConfig;
  private ctx_: v8Types.Debug;
  private evaluatedExpressions_: apiTypes.Variable[];
  private totalSize_: number;
  private messageTable_: apiTypes.Variable[];
  private resolvedVariableTable_: apiTypes.Variable[];
  private rawVariableTable_: Array<v8Types.ValueMirror|null>;

  /**
   * @param {!Object} execState
   * @param {Array<string>} expressions
   * @param {!Object} config
   * @constructor
   */
  constructor(
      execState: v8Types.ExecutionState, expressions: string[],
      config: DebugAgentConfig, v8: v8Types.Debug) {
    this.state_ = execState;
    this.expressions_ = expressions;
    this.config_ = config;
    this.ctx_ = v8;

    this.evaluatedExpressions_ = [];
    this.totalSize_ = 0;

    this.messageTable_ = [];
    this.messageTable_[BUFFER_FULL_MESSAGE_INDEX] = {
      status: new StatusMessage(
          StatusMessage.VARIABLE_VALUE, 'Max data size reached', true)
    };
    this.messageTable_[NATIVE_PROPERTY_MESSAGE_INDEX] = {
      status: new StatusMessage(
          StatusMessage.VARIABLE_VALUE, 'Native properties are not available',
          true)
    };
    this.messageTable_[GETTER_MESSAGE_INDEX] = {
      status: new StatusMessage(
          StatusMessage.VARIABLE_VALUE,
          'Properties with getters are not available', true)
    };
    this.messageTable_[ARG_LOCAL_LIMIT_MESSAGE_INDEX] = {
      status: new StatusMessage(
          StatusMessage.VARIABLE_VALUE,
          'Locals and arguments are only displayed for the ' +
              'top `config.capture.maxExpandFrames=' +
              config.capture.maxExpandFrames + '` stack frames.',
          true)
    };

    // TODO: Determine why _extend is used here
    this.resolvedVariableTable_ = (util as any)._extend([], this.messageTable_);
    this.rawVariableTable_ = this.messageTable_.map(function() {
      return null;
    });
  }


  /**
   * Captures the stack and current execution state.
   *
   * @return an object with stackFrames, variableTable, and
   *         evaluatedExpressions fields
   */
  capture_(): apiTypes.Breakpoint {
    const that = this;

    // Evaluate the watch expressions
    const evalIndexSet = new Set();
    if (that.expressions_) {
      that.expressions_.forEach(function(expression, index2) {
        const result = evaluate(expression, that.state_.frame(0));
        let evaluated;

        if (result.error) {
          evaluated = {
            name: expression,
            status: new StatusMessage(
                StatusMessage.VARIABLE_VALUE, result.error, true)
          };
        } else {
          // TODO: Determine how to not downcast this to v8Types.ValueMirror
          // TODO: Handle the case where `result.mirror` is `undefined`.
          evaluated = that.resolveVariable_(
              expression, result.mirror as v8Types.ValueMirror, true);
          const varTableIdx = evaluated.varTableIndex;
          if (typeof varTableIdx !== 'undefined') {
            evalIndexSet.add(varTableIdx);
          }
        }
        that.evaluatedExpressions_[index2] = evaluated;
      });
    }

    // The frames are resolved after the evaluated expressions so that
    // evaluated expressions can be evaluated as much as possible within
    // the max data size limits
    const frames = that.resolveFrames_();

    // Now resolve the variables
    let index = this.messageTable_.length;  // skip the sentinel values
    const noLimit = that.config_.capture.maxDataSize === 0;
    while (index <
               that.rawVariableTable_.length &&  // NOTE: length changes in loop
           (that.totalSize_ < that.config_.capture.maxDataSize || noLimit)) {
      assert(!that.resolvedVariableTable_[index]);  // shouldn't have it
                                                    // resolved yet
      const isEvaluated = evalIndexSet.has(index);
      // TODO: This code suggests that an ObjectMirror and Stutus are the
      //       same.  Resolve this.
      that.resolvedVariableTable_[index] = that.resolveMirror_(
          that.rawVariableTable_[index] as v8Types.ObjectMirror, isEvaluated);
      index++;
    }

    // If we filled up the buffer already, we need to trim the remainder
    if (index < that.rawVariableTable_.length) {
      that.trimVariableTable_(index, frames);
    }

    return {
      stackFrames: frames,
      variableTable: that.resolvedVariableTable_,
      evaluatedExpressions: that.evaluatedExpressions_
    };
  }

  /**
   * Limits the size of the variable table to `fromIndex` elements. It marks
   * all variables with entries beyond `fromIndex` with a message indicating
   * that the table filled.
   *
   * @param {Number} fromIndex The desired size of the variable table.
   * @param {Object} frames Frames associated with the current execution
   *                        environment.
   */
  trimVariableTable_(fromIndex: number, frames: apiTypes.StackFrame[]): void {
    this.resolvedVariableTable_.splice(
        fromIndex);  // remove the remaining entries

    const that = this;
    const processBufferFull = function(variables: apiTypes.Variable[]) {
      variables.forEach(function(variable) {
        if (variable.varTableIndex && variable.varTableIndex >= fromIndex) {
          // make it point to the sentinel 'buffer full' value
          variable.varTableIndex = BUFFER_FULL_MESSAGE_INDEX;
          variable.status =
              that.messageTable_[BUFFER_FULL_MESSAGE_INDEX].status;
        }
        if (variable.members) {
          processBufferFull(variable.members);
        }
      });
    };

    frames.forEach(function(frame) {
      processBufferFull(frame.arguments);
      processBufferFull(frame.locals);
    });
    processBufferFull(this.evaluatedExpressions_);
    processBufferFull(this.resolvedVariableTable_);
  }

  resolveFrames_(): apiTypes.StackFrame[] {
    const frames: apiTypes.StackFrame[] = [];
    const frameCount =
        Math.min(this.state_.frameCount(), this.config_.capture.maxFrames);

    for (let i = 0; i < frameCount; i++) {
      const frame = this.state_.frame(i);
      if (this.shouldFrameBeResolved_(frame)) {
        frames.push(this.resolveFrame_(
            frame, (i < this.config_.capture.maxExpandFrames)));
      }
    }
    return frames;
  }

  shouldFrameBeResolved_(frame: v8Types.FrameMirror): boolean {
    // Only capture data from the frames for which we can link the data back
    // to the source files.

    const fullPath = this.resolveFullPath_(frame);

    if (!this.isPathInCurrentWorkingDirectory_(fullPath)) {
      return false;
    }

    const relativePath = this.resolveRelativePath_(frame);
    if (!this.config_.capture.includeNodeModules &&
        this.isPathInNodeModulesDirectory_(relativePath)) {
      return false;
    }

    return true;
  }

  resolveFullPath_(frame: v8Types.FrameMirror): string {
    const func = frame.func();
    if (!func.resolved()) {
      return '';
    }

    const script = func.script();
    if (!script) {
      return '';
    }

    return script.name();
  }

  resolveRelativePath_(frame: v8Types.FrameMirror): string {
    const fullPath = this.resolveFullPath_(frame);
    return this.stripCurrentWorkingDirectory_(fullPath);
  }

  stripCurrentWorkingDirectory_(path: string): string {
    // Strip 1 extra character to remove the slash.
    // TODO: Handle the case where `this.config_.workingDirectory` is `null`.
    return path.substr((this.config_.workingDirectory as string).length + 1);
  }

  isPathInCurrentWorkingDirectory_(path: string): boolean {
    // return true;
    // TODO: Handle the case where `this.config_.workingDirectory` is `null`.
    return path.indexOf(this.config_.workingDirectory as string) === 0;
  }

  isPathInNodeModulesDirectory_(path: string): boolean {
    return path.indexOf('node_modules') === 0;
  }

  resolveFrame_(frame: v8Types.FrameMirror, underFrameCap: boolean):
      apiTypes.StackFrame {
    let args: Array<apiTypes.Variable> = [];
    // TODO: `locals` should be of type v8Types.ScopeMirror[]
    //       Resolve conflicts so that it can be specified of that type.
    let locals: Array<any> = [];
    // Locals and arguments are safe to collect even when
    // `config.allowExpressions=false` since we properly avoid inspecting
    // interceptors and getters by default.
    if (!underFrameCap) {
      args.push({
        name: 'arguments_not_available',
        varTableIndex: ARG_LOCAL_LIMIT_MESSAGE_INDEX
      });
      locals.push({
        name: 'locals_not_available',
        varTableIndex: ARG_LOCAL_LIMIT_MESSAGE_INDEX
      });
    } else {
      // We will use the values aggregated from the ScopeMirror traversal stored
      // in locals which will include any applicable arguments from the
      // invocation.
      args = [];
      locals = this.resolveLocalsList_(frame, args);
      if (isEmpty(locals)) {
        locals = [];
      }
    }
    return {
      function: this.resolveFunctionName_(frame.func()),
      location: this.resolveLocation_(frame),
      arguments: args,
      locals: locals
    };
  }

  resolveFunctionName_(func: v8Types.FunctionMirror): string {
    if (!func || !func.isFunction()) {
      return '';
    }
    return func.name() || func.inferredName() || '(anonymous function)';
  }

  resolveLocation_(frame: v8Types.FrameMirror): apiTypes.SourceLocation {
    return {
      path: this.resolveRelativePath_(frame),
      // V8 uses 0-based line numbers but Debuglet API uses 1-based numbers.
      line: frame.sourceLine() + 1
    };
  }

  // TODO: This method doesn't appear to be used.  Determine if it can be
  //       removed.
  extractArgumentsList_(frame: v8Types.FrameDetails): apiTypes.Variable[] {
    const args: apiTypes.Variable[] = [];
    for (let i = 0; i < frame.argumentCount(); i++) {
      // Don't resolve unnamed arguments.
      if (!frame.argumentName(i)) {
        continue;
      }
      args.push({name: frame.argumentName(i), value: frame.argumentValue(i)});
    }
    return args;
  }

  /**
   * Iterates and returns variable information for all scopes (excluding global)
   * in a given frame. FrameMirrors should return their scope object list with
   * most deeply nested scope first so variables initially encountered will take
   * precedence over subsequent instance with the same name - this is tracked in
   * the usedNames map. The argument list given to this function may be
   * manipulated if variables with a deeper scope occur which have the same
   * name.
   * @function resolveLocalsList_
   * @memberof StateResolver
   * @param {FrameMirror} frame - A instance of FrameMirror
   * @param {Array<Object>} args - An array of objects representing any function
   *  arguments the frame may list
   * @returns {Array<Object>} - returns an array containing data about selected
   *  variables
   */
  resolveLocalsList_(frame: v8Types.FrameMirror, args: any):
      v8Types.ScopeMirror[] {
    // TODO: Determine why `args` is never used in this function
    args = args;

    const self = this;
    const usedNames: {[name: string]: boolean} = {};
    const makeMirror = this.ctx_.MakeMirror;
    const allScopes = frame.allScopes();
    const count = allScopes.length;

    // There will always be at least 3 scopes.
    // For top-level breakpoints: [local, script, global]
    // Other: [..., closure (module IIFE), script, global]
    assert(count >= 3);
    assert.strictEqual(allScopes[count - 1].scopeType(), ScopeType.Global);
    assert.strictEqual(allScopes[count - 2].scopeType(), ScopeType.Script);

    // We find the top-level (module global) variable pollute the local
    // variables we omit them by default, unless the breakpoint itself is
    // top-level. The last two scopes are always omitted.
    let scopes: v8Types.ScopeMirror[];
    if (allScopes[count - 3].scopeType() === ScopeType.Closure) {
      scopes = allScopes.slice(0, -3);
    } else {
      assert(allScopes[count - 3].scopeType() === ScopeType.Local);
      scopes = allScopes.slice(0, -2);
    }

    return flatten(scopes.map(function(scope: v8Types.ScopeMirror) {
             return transform(
                 // TODO: Update this so that `locals` is not of type `any[]`.
                 scope.details().object(),
                 function(locals: any[], value, name: string) {
                   const trg = makeMirror(value);
                   if (!usedNames[name]) {
                     // It's a valid variable that belongs in the locals list
                     // and wasn't discovered at a lower-scope
                     usedNames[name] = true;
                     // TODO: Determine how to not have an explicit down cast to
                     // ValueMirror
                     locals.push(self.resolveVariable_(
                         name, trg as v8Types.ValueMirror, false));
                   }  // otherwise another same-named variable occured at a
                      // lower scope
                   return locals;
                 },
                 []);
           }))
        .concat((function() {
          // The frame receiver is the 'this' context that is present during
          // invocation. Check to see whether a receiver context is substantive,
          // (invocations may be bound to null) if so: store in the locals list
          // under the name 'context' which is used by the Chrome DevTools.
          const ctx = frame.details().receiver();
          if (ctx) {
            // TODO: Determine how to not have an explicit down cast to
            // ValueMirror
            return [self.resolveVariable_(
                'context', makeMirror(ctx) as v8Types.ValueMirror, false)];
          }
          return [];
        }()));
  }

  /**
   * Computes a text representation of the provided value based on its type.
   * If the value is a recursive data type, it will be represented as an index
   * into the variable table.
   *
   * @param {String} name The name of the variable.
   * @param {Object} value A v8 debugger representation of a variable value.
   * @param {boolean} isEvaluated Specifies if the variable is from a watched
   *                              expression.
   */
  resolveVariable_(
      name: string, value: v8Types.ValueMirror,
      isEvaluated: boolean): apiTypes.Variable {
    let size = name.length;

    const data: apiTypes.Variable = {name: name};

    if (value.isPrimitive() || value.isRegExp()) {
      // primitives: undefined, null, boolean, number, string, symbol
      data.value = value.toText();
      const maxLength = this.config_.capture.maxStringLength;
      if (!isEvaluated && maxLength && maxLength < data.value.length) {
        data.status = new StatusMessage(
            StatusMessage.VARIABLE_VALUE,
            'Only first `config.capture.maxStringLength=' +
                this.config_.capture.maxStringLength +
                '` chars were captured for string of length ' +
                data.value.length +
                '. Use in an expression to see the full string.',
            false);
        data.value = data.value.substring(0, maxLength) + '...';
      }

    } else if (value.isFunction()) {
      // TODO: Determine how to resolve this so that a ValueMirror doesn't need
      //       to be cast to a FunctionMirror.
      data.value = 'function ' +
          this.resolveFunctionName_(value as v8Types.FunctionMirror) + '()';
    } else if (value.isObject()) {
      data.varTableIndex = this.getVariableIndex_(value);
    } else {
      // PropertyMirror, InternalPropertyMirror, FrameMirror, ScriptMirror
      data.value = 'unknown mirror type';
    }

    if (data.value) {
      size += data.value.length;
    } else {
      size += 8;  // fudge-it
    }

    this.totalSize_ += size;

    return data;
  }

  getVariableIndex_(value: v8Types.ValueMirror): number {
    let idx = this.rawVariableTable_.indexOf(value);
    if (idx === -1) {
      idx = this.storeObjectToVariableTable_(value);
    }
    return idx;
  }

  storeObjectToVariableTable_(obj: v8Types.ValueMirror): number {
    let idx = this.rawVariableTable_.length;
    this.rawVariableTable_[idx] = obj;
    return idx;
  }

  /**
   * Responsible for recursively resolving the properties on a
   * provided object mirror.
   */
  resolveMirror_(mirror: v8Types.ObjectMirror, isEvaluated: boolean):
      apiTypes.Variable {
    let properties = mirror.properties();
    const maxProps = this.config_.capture.maxProperties;
    const truncate = maxProps && properties.length > maxProps;
    if (!isEvaluated && truncate) {
      properties = properties.slice(0, maxProps);
    }
    // TODO: It looks like `members` should be of type apiTypes.Variable[]
    //       but is missing fields.  Determine if those fields are required or
    //       if the type should not be apiTypes.Variable[]
    const members =
        properties.map(this.resolveMirrorProperty_.bind(this, isEvaluated));
    if (!isEvaluated && truncate) {
      // TDOO: Determine how to remove this explicit cast
      members.push({
        name: 'Only first `config.capture.maxProperties=' +
            this.config_.capture.maxProperties +
            '` properties were captured. Use in an expression' +
            ' to see all properties.'
      });
    }
    return {value: mirror.toText(), members: members};
  }

  resolveMirrorProperty_(
      isEvaluated: boolean,
      property: v8Types.PropertyMirror): apiTypes.Variable {
    const name = String(property.name());
    // Array length must be special cased as it is a native property that
    // we know to be safe to evaluate which is not generally true.
    const isArrayLen = property.mirror_.isArray() && name === 'length';
    if (property.isNative() && !isArrayLen) {
      return {name: name, varTableIndex: NATIVE_PROPERTY_MESSAGE_INDEX};
    }
    if (property.hasGetter()) {
      return {name: name, varTableIndex: GETTER_MESSAGE_INDEX};
    }
    return this.resolveVariable_(name, property.value(), isEvaluated);
  }
}

// This function is used by unit tests to make sure assertions are enabled.
export function testAssert(): void {
  assert.equal(0, 1);
}
