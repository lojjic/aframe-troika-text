(function (aframe, three) {
  'use strict';

  aframe = aframe && aframe.hasOwnProperty('default') ? aframe['default'] : aframe;

  /**
   * Lightweight thenable implementation that is entirely self-contained within a single
   * function with no external dependencies so it can be easily shipped across to a WorkerModule.
   *
   * This implementation conforms fully to the Promises/A+ spec so it can safely interoperate
   * with other thenable implementations. https://github.com/promises-aplus/promises-spec
   *
   * *However*, it is _not_ a full implementation of ES2015 Promises, e.g. it does not
   * have the same constructor signature and does not expose a `catch` method or the static
   * `resolve`/`reject`/`all`/`race` initializer methods. If you need to hand a Thenable
   * instance off to consuming code that may expect a true Promise, you'll want to wrap it
   * in a native-or-polyfilled Promise first.
   *
   * (Why yet another Promises/A+ implementation? Great question. We needed a polyfill-like
   * thing that was (a) wrapped in a single function for easy serialization across to a Worker,
   * and (b) was as small as possible -- at ~900B minified (~500B gzipped) this is the smallest
   * implementation I've found. And also, exercises like this are challenging and fun.)
   */
  function BespokeThenable() {
    var state = 0; // 0=pending, 1=fulfilled, -1=rejected
    var queue = [];
    var value;
    var scheduled = 0;
    var completeCalled = 0;

    function then(onResolve, onReject) {
      var nextThenable = BespokeThenable();

      function handleNext() {
        var cb = state > 0 ? onResolve : onReject;
        if (isFn(cb)) {
          try {
            var result = cb(value);
            if (result === nextThenable) {
              recursiveError();
            }
            var resultThen = getThenableThen(result);
            if (resultThen) {
              resultThen.call(result, nextThenable.resolve, nextThenable.reject);
            } else {
              nextThenable.resolve(result);
            }
          } catch (err) {
            nextThenable.reject(err);
          }
        } else {
          nextThenable[state > 0 ? 'resolve' : 'reject'](value);
        }
      }

      queue.push(handleNext);
      if (state) {
        scheduleQueueFlush();
      }
      return nextThenable
    }

    var resolve = oneTime(function (val) {
      if (!completeCalled) {
        complete(1, val);
      }
    });

    var reject = oneTime(function (reason) {
      if (!completeCalled) {
        complete(-1, reason);
      }
    });

    function complete(st, val) {
      completeCalled++;
      var ignoreThrow = 0;
      try {
        if (val === thenableObj) {
          recursiveError();
        }
        var valThen = st > 0 && getThenableThen(val);
        if (valThen) {
          valThen.call(val, oneTime(function (v) {
            ignoreThrow++;
            complete(1, v);
          }), oneTime(function (v) {
            ignoreThrow++;
            complete(-1, v);
          }));
        } else {
          state = st;
          value = val;
          scheduleQueueFlush();
        }
      } catch(e) {
        if (!state && !ignoreThrow) {
          complete(-1, e);
        }
      }
    }

    function scheduleQueueFlush() {
      if (!scheduled) {
        setTimeout(flushQueue, 0); //TODO setImmediate or postMessage approach if available?
        scheduled = 1;
      }
    }

    function flushQueue() {
      var q = queue;
      scheduled = 0;
      queue = [];
      q.forEach(callIt);
    }

    function callIt(fn) {
      fn();
    }

    function getThenableThen(val) {
      var valThen = val && (isFn(val) || typeof val === 'object') && val.then;
      return isFn(valThen) && valThen
    }

    function oneTime(fn) {
      var called = 0;
      return function() {
        var args = [], len = arguments.length;
        while ( len-- ) args[ len ] = arguments[ len ];

        if (!called++) {
          fn.apply(this, args);
        }
      }
    }

    function recursiveError() {
      throw new TypeError('Chaining cycle detected')
    }

    var isFn = function (v) { return typeof v === 'function'; };

    var thenableObj = {
      then: then,
      resolve: resolve,
      reject: reject
    };
    return thenableObj
  }


  /**
   * Thenable implementation that uses a native Promise under the covers. This implementation
   * is preferred if Promise is available, for better performance and dev tools integration.
   * @constructor
   */
  function NativePromiseThenable() {
    var resolve, reject;
    var promise = new Promise(function (res, rej) {
      resolve = res;
      reject = rej;
    });
    return {
      then: promise.then.bind(promise),
      resolve: resolve,
      reject: reject
    }
  }


  /**
   * Choose the best Thenable implementation and export it as the default.
   */
  var Thenable = (
    typeof Promise === 'function' ? NativePromiseThenable : BespokeThenable
  );

  var _workerModuleId = 0;
  var _messageId = 0;
  var worker = null;

  var openRequests = Object.create(null);
  openRequests._count = 0;


  /**
   * Define a module of code that will be executed with a web worker. This provides a simple
   * interface for moving chunks of logic off the main thread, and managing their dependencies
   * among one another.
   *
   * @param {object} options
   * @param {function} options.init - The main function that initializes the module. This will be run
   *        within the worker, and will be passed the resolved dependencies as arguments. Its
   *        return value becomes the module's content, which can then be used by other modules
   *        that depend on it. This function can perform any logic using those dependencies, but
   *        must not depend on anything from its parent closures.
   * @param {array} [options.dependencies] - Provides any dependencies required by the init function:
   *        - Primitives like strings, numbers, booleans
   *        - Raw functions; these will be stringified and rehydrated within the worker so they
   *          must not depend on anything from their parent closures
   *        - Other worker modules; these will be resolved within the worker, and therefore modules
   *          that provide functions can be called without having to cross the worker/main thread
   *          boundary.
   * @param {function} [options.getTransferables] - An optional function that will be run in the worker
   *        just before posting the response value from a module call back to the main thread.
   *        It will be passed that response value, and if it returns an array then that will be
   *        used as the "transferables" parameter to `postMessage`. Use this if there are values
   *        in the response that can/should be transfered rather than cloned.
   * @return {function(...[*]): {then}}
   */
  function defineWorkerModule(options) {
    if (!options || typeof options.init !== 'function') {
      throw new Error('requires `options.init` function')
    }
    var dependencies = options.dependencies;
    var init = options.init;
    var getTransferables = options.getTransferables;
    var id = "workerModule" + (++_workerModuleId);
    var registrationThenable = null;

    dependencies = dependencies && dependencies.map(function (dep) {
      // Wrap raw functions as worker modules with no dependencies
      if (typeof dep === 'function' && !dep.workerModuleData) {
        dep = defineWorkerModule({
          init: new Function(("return function(){return (" + (stringifyFunction(dep)) + ")}"))()
        });
      }
      // Grab postable data for worker modules
      if (dep && dep.workerModuleData) {
        dep = dep.workerModuleData;
      }
      return dep
    });

    function moduleFunc() {
      var args = [], len = arguments.length;
      while ( len-- ) args[ len ] = arguments[ len ];

      // Register this module if needed
      if (!registrationThenable) {
        registrationThenable = callWorker('registerModule', moduleFunc.workerModuleData);
      }

      // Invoke the module, returning a thenable
      return registrationThenable.then(function (ref) {
        var isCallable = ref.isCallable;

        if (isCallable) {
          return callWorker('callModule', {id: id, args: args})
        } else {
          throw new Error('Worker module function was called but `init` did not return a callable function')
        }
      })
    }
    moduleFunc.workerModuleData = {
      isWorkerModule: true,
      id: id,
      dependencies: dependencies,
      init: stringifyFunction(init),
      getTransferables: getTransferables && stringifyFunction(getTransferables)
    };
    return moduleFunc
  }

  /**
   * Stringifies a function into a form that can be deserialized in the worker
   * @param fn
   */
  function stringifyFunction(fn) {
    var str = fn.toString();
    // If it was defined in object method/property format, it needs to be modified
    if (!/^function/.test(str) && /^\w+\s*\(/.test(str)) {
      str = 'function ' + str;
    }
    return str
  }


  function getWorker() {
    if (!worker) {
      // Bootstrap the worker's content
      var bootstrap = (function() {
        var modules = Object.create(null);

        // Handle messages for registering a module
        function registerModule(ref, callback) {
          var id = ref.id;
          var dependencies = ref.dependencies; if ( dependencies === void 0 ) dependencies = [];
          var init = ref.init; if ( init === void 0 ) init = function(){};
          var getTransferables = ref.getTransferables; if ( getTransferables === void 0 ) getTransferables = null;

          // Only register once
          if (modules[id]) { return }

          try {
            // If any dependencies are modules, ensure they're registered and grab their value
            dependencies = dependencies.map(function (dep) {
              if (dep && dep.isWorkerModule) {
                registerModule(dep, function (depResult) {
                  if (depResult instanceof Error) { throw depResult }
                });
                dep = modules[dep.id].value;
              }
              return dep
            });

            // Rehydrate functions
            init = new Function(("return (" + init + ")"))();
            if (getTransferables) {
              getTransferables = new Function(("return (" + getTransferables + ")"))();
            }

            // Initialize the module and store its value
            var value = init.apply(void 0, dependencies);
            modules[id] = {
              id: id,
              value: value,
              getTransferables: getTransferables
            };
            callback(value);
          } catch(err) {
            if (!(err && err.noLog)) {
              console.error(err);
            }
            callback(err);
          }
        }

        // Handle messages for calling a registered module's result function
        function callModule(ref, callback) {
          var ref$1;

          var id = ref.id;
          var args = ref.args;
          if (!modules[id] || typeof modules[id].value !== 'function') {
            callback(new Error(("Worker module " + id + ": not found or its 'init' did not return a function")));
          }
          try {
            var result = (ref$1 = modules[id]).value.apply(ref$1, args);
            if (result && typeof result.then === 'function') {
              result.then(handleResult, function (rej) { return callback(rej instanceof Error ? rej : new Error('' + rej)); });
            } else {
              handleResult(result);
            }
          } catch(err) {
            callback(err);
          }
          function handleResult(result) {
            try {
              var tx = modules[id].getTransferables && modules[id].getTransferables(result);
              if (!tx || !Array.isArray(tx) || !tx.length) {
                tx = undefined; //postMessage is very picky about not passing null or empty transferables
              }
              callback(result, tx);
            } catch(err) {
              console.error(err);
              callback(err);
            }
          }
        }

        // Handler for all messages within the worker
        self.addEventListener('message', function (e) {
          var ref = e.data;
          var messageId = ref.messageId;
          var action = ref.action;
          var data = ref.data;
          try {
            // Module registration
            if (action === 'registerModule') {
              registerModule(data, function (result) {
                if (result instanceof Error) {
                  postMessage({
                    messageId: messageId,
                    success: false,
                    error: result.message
                  });
                } else {
                  postMessage({
                    messageId: messageId,
                    success: true,
                    result: {isCallable: typeof result === 'function'}
                  });
                }
              });
            }
            // Invocation
            if (action === 'callModule') {
              callModule(data, function (result, transferables) {
                if (result instanceof Error) {
                  postMessage({
                    messageId: messageId,
                    success: false,
                    error: result.message
                  });
                } else {
                  postMessage({
                    messageId: messageId,
                    success: true,
                    result: result
                  }, transferables || undefined);
                }
              });
            }
          } catch(err) {
            postMessage({
              messageId: messageId,
              success: false,
              error: err.stack
            });
          }
        });
      }).toString();

      // Create the worker from the bootstrap function content
      worker = new Worker(
        URL.createObjectURL(
          new Blob([(";(" + bootstrap + ")()")], {type: 'application/javascript'})
        )
      );

      // Single handler for response messages from the worker
      worker.onmessage = function (e) {
        var response = e.data;
        var msgId = response.messageId;
        var callback = openRequests[msgId];
        if (!callback) {
          throw new Error('WorkerModule response with empty or unknown messageId')
        }
        delete openRequests[msgId];
        openRequests.count--;
        callback(response);
      };
    }
    return worker
  }

  // Issue a call to the worker with a callback to handle the response
  function callWorker(action, data) {
    var thenable = Thenable();
    var messageId = ++_messageId;
    openRequests[messageId] = function (response) {
      if (response.success) {
        thenable.resolve(response.result);
      } else {
        thenable.reject(new Error(("Error in worker " + action + " call: " + (response.error))));
      }
    };
    openRequests._count++;
    if (openRequests.count > 1000) { //detect leaks
      console.warn('Large number of open WorkerModule requests, some may not be returning');
    }
    getWorker().postMessage({
      messageId: messageId,
      action: action,
      data: data
    });
    return thenable
  }

  /**
   * Just the {@link Thenable} function wrapped as a worker module. If another worker
   * module needs Thenable as a dependency, it's better to pass this module rather than
   * the raw function in its `dependencies` array so it only gets registered once.
   */
  var ThenableWorkerModule = defineWorkerModule({
    dependencies: [Thenable],
    init: function(Thenable) {
      return Thenable
    }
  });

  /**
   * Regular expression for matching the `void main() {` opener line in GLSL.
   * @type {RegExp}
   */
  var voidMainRegExp = /\bvoid\s+main\s*\(\s*\)\s*{/g;

  /**
   * Recursively expands all `#include <xyz>` statements within string of shader code.
   * Copied from three's WebGLProgram#parseIncludes for external use.
   *
   * @param {string} source - The GLSL source code to evaluate
   * @return {string} The GLSL code with all includes expanded
   */
  function expandShaderIncludes( source ) {
    var pattern = /^[ \t]*#include +<([\w\d./]+)>/gm;
    function replace(match, include) {
      var chunk = three.ShaderChunk[include];
      return chunk ? expandShaderIncludes(chunk) : match
    }
    return source.replace( pattern, replace )
  }

  // Local assign polyfill to avoid importing troika-core
  var assign = Object.assign || function(/*target, ...sources*/) {
    var arguments$1 = arguments;

    var target = arguments[0];
    for (var i = 1, len = arguments.length; i < len; i++) {
      var source = arguments$1[i];
      if (source) {
        for (var prop in source) {
          if (source.hasOwnProperty(prop)) {
            target[prop] = source[prop];
          }
        }
      }
    }
    return target
  };


  var idCtr = 0;
  var CACHE = new WeakMap(); //threejs requires WeakMap internally so should be safe to assume support


  /**
   * A utility for creating a custom shader material derived from another material's
   * shaders. This allows you to inject custom shader logic and transforms into the
   * builtin ThreeJS materials without having to recreate them from scratch.
   *
   * @param {THREE.Material} baseMaterial - the original material to derive from
   *
   * @param {Object} options - How the base material should be modified.
   * @param {Object} options.defines - Custom `defines` for the material
   * @param {Object} options.extensions - Custom `extensions` for the material, e.g. `{derivatives: true}`
   * @param {Object} options.uniforms - Custom `uniforms` for use in the modified shader. These can
   *        be accessed and manipulated via the resulting material's `uniforms` property, just like
   *        in a ShaderMaterial. You do not need to repeat the base material's own uniforms here.
   * @param {String} options.vertexDefs - Custom GLSL code to inject into the vertex shader's top-level
   *        definitions, above the `void main()` function.
   * @param {String} options.vertexMainIntro - Custom GLSL code to inject at the top of the vertex
   *        shader's `void main` function.
   * @param {String} options.vertexTransform - Custom GLSL code to manipulate the `position`, `normal`,
   *        and/or `uv` vertex attributes. This code will be wrapped within a standalone function with
   *        those attributes exposed by their normal names as read/write values.
   * @param {String} options.fragmentDefs - Custom GLSL code to inject into the fragment shader's top-level
   *        definitions, above the `void main()` function.
   * @param {String} options.fragmentMainIntro - Custom GLSL code to inject at the top of the fragment
   *        shader's `void main` function.
   * @param {String} options.fragmentColorTransform - Custom GLSL code to manipulate the `gl_FragColor`
   *        output value. Will be injected after all other `void main` logic has executed.
   *        TODO allow injecting before base shader logic or elsewhere?
   *
   * @return {THREE.Material}
   */
  function createDerivedMaterial(baseMaterial, options) {
    // First check the cache to see if we've already derived from this baseMaterial using
    // this unique set of options, and if so just return a clone instead of a new subclass
    // which is faster and allows their shader program to be shared when rendering.
    var optionsHash = getOptionsHash(options);
    var cached = CACHE.get(baseMaterial);
    if (!cached) {
      cached = Object.create(null);
      CACHE.set(baseMaterial, cached);
    }
    if (cached[optionsHash]) {
      return cached[optionsHash].clone()
    }

    var id = ++idCtr;
    var privateDerivedShadersProp = "_derivedShaders" + id;
    var privateBeforeCompileProp = "_onBeforeCompile" + id;

    // Private onBeforeCompile handler that injects the modified shaders and uniforms when
    // the renderer switches to this material's program
    function onBeforeCompile(shaderInfo) {
      baseMaterial.onBeforeCompile.call(this, shaderInfo);

      // Upgrade the shaders, caching the result
      var ref = this[privateDerivedShadersProp] || (this[privateDerivedShadersProp] = {vertex: {}, fragment: {}});
      var vertex = ref.vertex;
      var fragment = ref.fragment;
      if (vertex.source !== shaderInfo.vertexShader || fragment.source !== shaderInfo.fragmentShader) {
        var upgraded = upgradeShaders(shaderInfo, options, id);
        vertex.source = shaderInfo.vertexShader;
        vertex.result = upgraded.vertexShader;
        fragment.source = shaderInfo.fragmentShader;
        fragment.result = upgraded.fragmentShader;
      }

      // Inject upgraded shaders and uniforms into the program
      shaderInfo.vertexShader = vertex.result;
      shaderInfo.fragmentShader = fragment.result;
      assign(shaderInfo.uniforms, this.uniforms);

      // Users can still add their own handlers on top of ours
      if (this[privateBeforeCompileProp]) {
        this[privateBeforeCompileProp](shaderInfo);
      }
    }

    function DerivedMaterial() {
      baseMaterial.constructor.apply(this, arguments);
    }
    DerivedMaterial.prototype = Object.create(baseMaterial, {
      constructor: {value: DerivedMaterial},
      isDerivedMaterial: {value: true},
      baseMaterial: {value: baseMaterial},

      onBeforeCompile: {
        get: function get() {
          return onBeforeCompile
        },
        set: function set(fn) {
          this[privateBeforeCompileProp] = fn;
        }
      },

      copy: {
        value: function (source) {
          baseMaterial.copy.call(this, source);
          if (!baseMaterial.isShaderMaterial && !baseMaterial.isDerivedMaterial) {
            this.extensions = source.extensions;
            this.defines = assign({}, source.defines);
            this.uniforms = three.UniformsUtils.clone(source.uniforms);
          }
          return this
        }
      }
    });

    var material = new DerivedMaterial();
    material.copy(baseMaterial);

    // Merge uniforms, defines, and extensions
    material.uniforms = assign(three.UniformsUtils.clone(baseMaterial.uniforms || {}), options.uniforms);
    material.defines = assign({}, baseMaterial.defines, options.defines);
    material.defines.TROIKA_DERIVED_MATERIAL = id; //force a program change from the base material
    material.extensions = assign({}, baseMaterial.extensions, options.extensions);

    cached[optionsHash] = material;
    return material.clone() //return a clone so changes made to it don't affect the cached object
  }


  function upgradeShaders(ref, options, id) {
    var vertexShader = ref.vertexShader;
    var fragmentShader = ref.fragmentShader;

    var vertexDefs = options.vertexDefs;
    var vertexMainIntro = options.vertexMainIntro;
    var vertexTransform = options.vertexTransform;
    var fragmentDefs = options.fragmentDefs;
    var fragmentMainIntro = options.fragmentMainIntro;
    var fragmentColorTransform = options.fragmentColorTransform;

    // Modify vertex shader
    if (vertexDefs || vertexMainIntro || vertexTransform) {
      // If there's a position transform, we need to:
      // - expand all include statements
      // - replace all usages of the `position` attribute with a mutable variable
      // - inject the transform code into a function and call it to transform the position
      if (vertexTransform) {
        vertexShader = expandShaderIncludes(vertexShader);
        vertexDefs = (vertexDefs || '') + "\nvoid troikaVertexTransform" + id + "(inout vec3 position, inout vec3 normal, inout vec2 uv) {\n  " + vertexTransform + "\n}\n";
        vertexShader = vertexShader.replace(/\b(position|normal|uv)\b/g, function (match, match1, index, fullStr) {
          return /\battribute\s+vec3\s+$/.test(fullStr.substr(0, index)) ? match1 : ("troika_" + match1 + "_" + id)
        });
        vertexMainIntro = "\nvec3 troika_position_" + id + " = vec3(position);\nvec3 troika_normal_" + id + " = vec3(normal);\nvec2 troika_uv_" + id + " = vec2(uv);\ntroikaVertexTransform" + id + "(troika_position_" + id + ", troika_normal_" + id + ", troika_uv_" + id + ");\n" + (vertexMainIntro || '') + "\n";
      }

      vertexShader = vertexShader.replace(
        voidMainRegExp,
        ((vertexDefs || '') + "\n\n$&\n\n" + (vertexMainIntro || '')));
    }

    // Modify fragment shader
    if (fragmentDefs || fragmentMainIntro || fragmentColorTransform) {
      fragmentShader = expandShaderIncludes(fragmentShader);
      fragmentShader = fragmentShader.replace(voidMainRegExp, ("\n" + (fragmentDefs || '') + "\nvoid troikaOrigMain" + id + "() {\n" + (fragmentMainIntro || '') + "\n"));
      fragmentShader += "\nvoid main() {\n  troikaOrigMain" + id + "();\n  " + (fragmentColorTransform || '') + "\n}";
    }

    return {
      vertexShader: vertexShader,
      fragmentShader: fragmentShader
    }
  }


  function getOptionsHash(options) {
    return JSON.stringify(options, optionsJsonReplacer)
  }
  function optionsJsonReplacer(key, value) {
    return key === 'uniforms' ? undefined : value
  }

  /**
   * @class ShaderFloatArray
   *
   * When writing a custom WebGL shader, sometimes you need to pass it an array of floating
   * point numbers that it can read from. Unfortunately this is very difficult to do in WebGL,
   * because:
   *
   *   - GLSL "array" uniforms can only be of a constant length.
   *   - Textures can only hold floating point numbers in WebGL1 if the `OES_texture_float`
   *     extension is available.
   *
   * ShaderFloatArray is an array-like abstraction that encodes its floating point data into
   * an RGBA texture's four Uint8 components, and provides the corresponding ThreeJS uniforms
   * and GLSL code for you to put in your custom shader to query the float values by array index.
   *
   * This should generally only be used within a fragment shader, as some environments (e.g. iOS)
   * only allow texture lookups in fragment shaders.
   *
   * TODO:
   *   - Use a float texture if the extension is available so we can skip the encoding process
   */
  var ShaderFloatArray = function ShaderFloatArray(name) {
    this.name = name;
    this.textureUniform = "dataTex_" + name;
    this.textureSizeUniform = "dataTexSize_" + name;
    this.multiplierUniform = "dataMultiplier_" + name;

    /**
     * @property dataSizeUniform - the name of the GLSL uniform that will hold the
     * length of the data array.
     * @type {string}
     */
    this.dataSizeUniform = "dataSize_" + name;

    /**
     * @property readFunction - the name of the GLSL function that should be called to
     * read data out of the array by index.
     * @type {string}
     */
    this.readFunction = "readData_" + name;

    this._raw = new Float32Array(0);
    this._texture = new three.DataTexture(new Uint8Array(0), 0, 1);
    this._length = 0;
    this._multiplier = 1;
  };

  var prototypeAccessors = { length: { configurable: true } };

  /**
   * @property length - the current length of the data array
   * @type {number}
   */
  prototypeAccessors.length.set = function (value) {
    if (value !== this._length) {
      // Find nearest power-of-2 that holds the new length
      var size = Math.pow(2, Math.ceil(Math.log2(value)));
      var raw = this._raw;
      if (size < raw.length) {
        this._raw = raw.subarray(0, size);
      }
      else if(size > raw.length) {
        this._raw = new Float32Array(size);
        this._raw.set(raw);
      }
      this._length = value;
    }
  };
  prototypeAccessors.length.get = function () {
    return this._length
  };

  /**
   * Add a value to the end of the data array
   * @param {number} value
   */
  ShaderFloatArray.prototype.push = function push (value) {
    return this.set(this.length++, value)
  };

  /**
   * Replace the existing data with that from a new array
   * @param {ArrayLike<number>} array
   */
  ShaderFloatArray.prototype.setArray = function setArray (array) {
    this.length = array.length;
    this._raw.set(array);
    this._needsRepack = true;
  };

  /**
   * Get the current value at index
   * @param {number} index
   * @return {number}
   */
  ShaderFloatArray.prototype.get = function get (index) {
    return this._raw[index]
  };

  ShaderFloatArray.prototype.set = function set (index, value) {
    if (index + 1 > this._length) {
      this.length = index + 1;
    }
    if (value !== this._raw[index]) {
      this._raw[index] = value;
      encodeFloatToFourInts(
        value / this._multiplier,
        this._texture.image.data,
        index * 4
      );
      this._needsMultCheck = true;
    }
  };

  /**
   * Make a copy of this ShaderFloatArray
   * @return {ShaderFloatArray}
   */
  ShaderFloatArray.prototype.clone = function clone () {
    var clone = new ShaderFloatArray(this.name);
    clone.setArray(this._raw);
    return clone
  };

  /**
   * Retrieve the set of Uniforms that must to be added to the target ShaderMaterial or
   * DerivedMaterial, to feed the GLSL code generated by {@link #getShaderHeaderCode}.
   * @return {Object}
   */
  ShaderFloatArray.prototype.getShaderUniforms = function getShaderUniforms () {
      var obj;

    var me = this;
    return ( obj = {}, obj[this.textureUniform] = {get value() {
        me._sync();
        return me._texture
      }}, obj[this.textureSizeUniform] = {get value() {
        me._sync();
        return me._texture.image.width
      }}, obj[this.dataSizeUniform] = {get value() {
        me._sync();
        return me.length
      }}, obj[this.multiplierUniform] = {get value() {
        me._sync();
        return me._multiplier
      }}, obj )
  };

  /**
   * Retrieve the GLSL code that must be injected into the shader's definitions area to
   * enable reading from the data array. This exposes a function with a name matching
   * the {@link #readFunction} property, which other shader code can call to read values
   * from the array by their index.
   * @return {string}
   */
  ShaderFloatArray.prototype.getShaderHeaderCode = function getShaderHeaderCode () {
    var ref = this;
      var textureUniform = ref.textureUniform;
      var textureSizeUniform = ref.textureSizeUniform;
      var dataSizeUniform = ref.dataSizeUniform;
      var multiplierUniform = ref.multiplierUniform;
      var readFunction = ref.readFunction;
    return ("\nuniform sampler2D " + textureUniform + ";\nuniform float " + textureSizeUniform + ";\nuniform float " + dataSizeUniform + ";\nuniform float " + multiplierUniform + ";\n\nfloat " + readFunction + "(float index) {\n  vec2 texUV = vec2((index + 0.5) / " + textureSizeUniform + ", 0.5);\n  vec4 pixel = texture2D(" + textureUniform + ", texUV);\n  return dot(pixel, 1.0 / vec4(1.0, 255.0, 65025.0, 16581375.0)) * " + multiplierUniform + ";\n}\n")
  };

  /**
   * @private Synchronize any pending changes to the underlying DataTexture
   */
  ShaderFloatArray.prototype._sync = function _sync () {
    var tex = this._texture;
    var raw = this._raw;
    var needsRepack = this._needsRepack;

    // If the size of the raw array changed, resize the texture to match
    if (raw.length !== tex.image.width) {
      tex.image = {
        data: new Uint8Array(raw.length * 4),
        width: raw.length,
        height: 1
      };
      needsRepack = true;
    }

    // If the values changed, check the multiplier. This should be a value by which
    // all the values are divided to constrain them to the [0,1] range required by
    // the Uint8 packing algorithm. We pick the nearest power of 2 that holds the
    // maximum value for greatest accuracy.
    if (needsRepack || this._needsMultCheck) {
      var maxVal = this._raw.reduce(function (a, b) { return Math.max(a, b); }, 0);
      var mult = Math.pow(2, Math.ceil(Math.log2(maxVal)));
      if (mult !== this._multiplier) {
        this._multiplier = mult;
        needsRepack = true;
      }
      tex.needsUpdate = true;
      this._needsMultCheck = false;
    }

    // If things changed in a way we need to repack, do so
    if (needsRepack) {
      for (var i = 0, len = raw.length, mult$1 = this._multiplier; i < len; i++) {
        encodeFloatToFourInts(raw[i] / mult$1, tex.image.data, i * 4);
      }
      this._needsRepack = false;
    }
  };

  Object.defineProperties( ShaderFloatArray.prototype, prototypeAccessors );



  /**
   * Encode a floating point number into a set of four 8-bit integers.
   * Also see the companion decoder function #decodeFloatFromFourInts.
   *
   * This is adapted to JavaScript from the basic approach at
   * http://aras-p.info/blog/2009/07/30/encoding-floats-to-rgba-the-final/
   * but writes out integers in the range 0-255 instead of floats in the range 0-1
   * so they can be more easily used in a Uint8Array for standard WebGL rgba textures.
   *
   * Some precision will necessarily be lost during the encoding and decoding process.
   * Testing shows that the maximum precision error is ~1.18e-10 which should be good
   * enough for most cases.
   *
   * @param {Number} value - the floating point number to encode. Must be in the range [0, 1]
   *        otherwise the results will be incorrect.
   * @param {Array|Uint8Array} array - an array into which the four ints should be written
   * @param {Number} startIndex - index in the output array at which to start writing the ints
   * @return {Array|Uint8Array}
   */
  function encodeFloatToFourInts(value, array, startIndex) {
    // This is adapted to JS from the basic approach at
    // http://aras-p.info/blog/2009/07/30/encoding-floats-to-rgba-the-final/
    // but writes to a Uint8Array instead of floats. Input values must be in
    // the range [0, 1]. The maximum error after encoding and decoding is ~1.18e-10
    var enc0 = 255 * value;
    var enc1 = 255 * (enc0 % 1);
    var enc2 = 255 * (enc1 % 1);
    var enc3 = 255 * (enc2 % 1);

    enc0 = enc0 & 255;
    enc1 = enc1 & 255;
    enc2 = enc2 & 255;
    enc3 = Math.round(enc3) & 255;

    array[startIndex] = enc0;
    array[startIndex + 1] = enc1;
    array[startIndex + 2] = enc2;
    array[startIndex + 3] = enc3;
    return array
  }

  /**
   * Initializes and returns a function to generate an SDF texture for a given glyph.
   * @param {number} config.sdfTextureSize - the length of one side of the resulting texture image.
   *                 Larger images encode more details. Should be a power of 2.
   * @param {number} config.sdfDistancePercent - see docs for SDF_DISTANCE_PERCENT in TextBuilder.js
   *
   * @return {function(Object): {renderingBounds: [minX, minY, maxX, maxY], textureData: Uint8Array}}
   */
  function createSDFGenerator(config) {
    var sdfTextureSize = config.sdfTextureSize;
    var sdfDistancePercent = config.sdfDistancePercent;

    /**
     * How many straight line segments to use when approximating a glyph's quadratic/cubic bezier curves.
     */
    var CURVE_POINTS = 16;

    var INF = Infinity;

    /**
     * Find the point on a quadratic bezier curve at t where t is in the range [0, 1]
     */
    function pointOnQuadraticBezier(x0, y0, x1, y1, x2, y2, t) {
      var t2 = 1 - t;
      return {
        x: t2 * t2 * x0 + 2 * t2 * t * x1 + t * t * x2,
        y: t2 * t2 * y0 + 2 * t2 * t * y1 + t * t * y2
      }
    }

    /**
     * Find the point on a cubic bezier curve at t where t is in the range [0, 1]
     */
    function pointOnCubicBezier(x0, y0, x1, y1, x2, y2, x3, y3, t) {
      var t2 = 1 - t;
      return {
        x: t2 * t2 * t2 * x0 + 3 * t2 * t2 * t * x1 + 3 * t2 * t * t * x2 + t * t * t * x3,
        y: t2 * t2 * t2 * y0 + 3 * t2 * t2 * t * y1 + 3 * t2 * t * t * y2 + t * t * t * y3
      }
    }

    /**
     * You're such a square.
     */
    function square(n) {
      return n * n
    }

    /**
     * Find the absolute distance from a point to a line segment at closest approach
     */
    function absDistanceToLineSegment(x, y, lineX0, lineY0, lineX1, lineY1) {
      var ldx = lineX1 - lineX0;
      var ldy = lineY1 - lineY0;
      var lengthSq = square(ldx) + square(ldy);
      var t = lengthSq ? Math.max(0, Math.min(1, ((x - lineX0) * ldx + (y - lineY0) * ldy) / lengthSq)) : 0;
      return Math.sqrt(square(x - (lineX0 + t * ldx)) + square(y - (lineY0 + t * ldy)))
    }


    /**
     * Basic quadtree impl for performing fast spatial searches of a glyph's line segments
     */
    var GlyphSegmentsQuadtree = function GlyphSegmentsQuadtree(glyphObj) {
      // Pick a good initial power-of-two bounding box that will hold all possible segments
      var xMin = glyphObj.xMin;
      var yMin = glyphObj.yMin;
      var xMax = glyphObj.xMax;
      var yMax = glyphObj.yMax;
      var dx = xMax - xMin;
      var dy = yMax - yMin;
      var cx = Math.round(xMin + dx / 2);
      var cy = Math.round(yMin + dy / 2);
      var r = Math.pow(2, Math.floor(Math.log(Math.max(dx, dy)) * Math.LOG2E));

      this._root = {
        0: null,
        1: null,
        2: null,
        3: null,
        data: null,
        cx: cx,
        cy: cy,
        r: r,
        minX: INF,
        minY: INF,
        maxX: -INF,
        maxY: -INF
      };
    };

    GlyphSegmentsQuadtree.prototype.addLineSegment = function addLineSegment (x0, y0, x1, y1) {
      var cx = (x0 + x1) / 2;
      var cy = (y0 + y1) / 2;
      var segment = {
        x0: x0, y0: y0, x1: x1, y1: y1, cx: cx, cy: cy,
        minX: Math.min(x0, x1),
        minY: Math.min(y0, y1),
        maxX: Math.max(x0, x1),
        maxY: Math.max(y0, y1),
        next: null
      };
      this._insertSegment(segment, this._root);
    };

    GlyphSegmentsQuadtree.prototype._insertSegment = function _insertSegment (segment, node) {
      // update node min/max stats
      var minX = segment.minX;
        var minY = segment.minY;
        var maxX = segment.maxX;
        var maxY = segment.maxY;
        var cx = segment.cx;
        var cy = segment.cy;
      if (minX < node.minX) { node.minX = minX; }
      if (minY < node.minY) { node.minY = minY; }
      if (maxX > node.maxX) { node.maxX = maxX; }
      if (maxY > node.maxY) { node.maxY = maxY; }

      // leaf
      var leafSegment = node.data;
      if (leafSegment) {
        // coincident; push as linked list
        if (leafSegment.cx === cx && leafSegment.cy === cy) {
          while (leafSegment.next) { leafSegment = leafSegment.next; }
          leafSegment.next = segment;
        }
        // non-coincident; split leaf to branch
        else {
          node.data = null;
          this._insertSegment(leafSegment, node);
          this._insertSegment(segment, node);
        }
      }
      // branch
      else {
        // find target sub-index for the segment's centerpoint
        var subIndex = (cy < node.cy ? 0 : 2) + (cx < node.cx ? 0 : 1);

        // subnode already at index: recurse
        if (node[subIndex]) {
          this._insertSegment(segment, node[subIndex]);
        }
        // create new leaf
        else {
          node[subIndex] = {
            0: null,
            1: null,
            2: null,
            3: null,
            data: segment,
            cx: node.cx + node.r / 2 * (subIndex % 2 ? 1 : -1),
            cy: node.cy + node.r / 2 * (subIndex < 2 ? -1 : 1),
            r: node.r / 2,
            minX: minX,
            minY: minY,
            maxX: maxX,
            maxY: maxY
          };
        }
      }
    };

    GlyphSegmentsQuadtree.prototype.walkTree = function walkTree (callback) {
      this.walkBranch(this._root, callback);
    };
    GlyphSegmentsQuadtree.prototype.walkBranch = function walkBranch (root, callback) {
        var this$1 = this;

      if (callback(root) !== false && !root.data) {
        for (var i = 0; i < 4; i++) {
          if (root[i] !== null) {
            this$1.walkBranch(root[i], callback);
          }
        }
      }
    };

    GlyphSegmentsQuadtree.prototype.findNearestSignedDistance = function findNearestSignedDistance (x, y, maxSearchRadius) {
      var closestDist = maxSearchRadius;

      this.walkTree(function visit(node) {
        // Ignore nodes that can't possibly have segments closer than what we've already found. We base
        // this on a simple rect bounds check; radial would be more accurate but much slower.
        if (
          x - closestDist > node.maxX || x + closestDist < node.minX ||
          y - closestDist > node.maxY || y + closestDist < node.minY
        ) {
          return false
        }

        // Leaf - check each segment's actual distance
        if (node.data) {
          for (var segment = node.data; segment; segment = segment.next) {
            if ( //fast prefilter for segment to avoid dist calc
              x - closestDist < segment.maxX || x + closestDist > segment.minX ||
              y - closestDist < segment.maxY || y + closestDist > segment.minY
            ) {
              var dist = absDistanceToLineSegment(x, y, segment.x0, segment.y0, segment.x1, segment.y1);
              if (dist < closestDist) {
                closestDist = dist;
              }
            }
          }
        }
      });

      // Flip to negative distance if outside the poly
      if (!this.isPointInPoly(x, y)) {
        closestDist = -closestDist;
      }
      return closestDist
    };

    GlyphSegmentsQuadtree.prototype.isPointInPoly = function isPointInPoly (x, y) {
      var inside = false;
      this.walkTree(function (node) {
        // Ignore nodes whose bounds can't possibly cross our east-pointing ray
        if (node.maxX < x || node.minY > y || node.maxY < y) {
          return false
        }

        // Leaf - test each segment for whether it crosses our east-pointing ray
        if (node.data) {
          for (var segment = node.data; segment; segment = segment.next) {
            var x0 = segment.x0;
              var y0 = segment.y0;
              var x1 = segment.x1;
              var y1 = segment.y1;
            var intersects = ((y0 > y) !== (y1 > y)) && (x < (x1 - x0) * (y - y0) / (y1 - y0) + x0);
            if (intersects) {
              inside = !inside;
            }
          }
        }
      });
      return inside
    };

    /**
     * Generate an SDF texture segment for a single glyph.
     * @param {object} glyphObj
     * @return {{textureData: Uint8Array, renderingBounds: *[]}}
     */
    function generateSDF(glyphObj) {
      //console.time('glyphSDF')

      var textureData = new Uint8Array(square(sdfTextureSize));

      // Determine mapping between glyph grid coords and sdf grid coords
      var glyphW = glyphObj.xMax - glyphObj.xMin;
      var glyphH = glyphObj.yMax - glyphObj.yMin;

      // Choose a maximum distance radius in font units, based on the glyph's max dimensions
      var fontUnitsMaxDist = Math.max(glyphW, glyphH) * sdfDistancePercent;

      // Use that, extending to the texture edges, to find conversion ratios between texture units and font units
      var fontUnitsPerXTexel = (glyphW + fontUnitsMaxDist * 2) / sdfTextureSize;
      var fontUnitsPerYTexel = (glyphH + fontUnitsMaxDist * 2) / sdfTextureSize;

      var textureMinFontX = glyphObj.xMin - fontUnitsMaxDist - fontUnitsPerXTexel;
      var textureMinFontY = glyphObj.yMin - fontUnitsMaxDist - fontUnitsPerYTexel;
      var textureMaxFontX = glyphObj.xMax + fontUnitsMaxDist + fontUnitsPerXTexel;
      var textureMaxFontY = glyphObj.yMax + fontUnitsMaxDist + fontUnitsPerYTexel;

      function textureXToFontX(x) {
        return textureMinFontX + (textureMaxFontX - textureMinFontX) * x / sdfTextureSize
      }

      function textureYToFontY(y) {
        return textureMinFontY + (textureMaxFontY - textureMinFontY) * y / sdfTextureSize
      }

      if (glyphObj.pathCommandCount) { //whitespace chars will have no commands, so we can skip all this
        // Decompose all paths into straight line segments and add them to a quadtree
        var lineSegmentsIndex = new GlyphSegmentsQuadtree(glyphObj);
        var firstX, firstY, prevX, prevY;
        glyphObj.forEachPathCommand(function (type, x0, y0, x1, y1, x2, y2) {
          switch (type) {
            case 'M':
              prevX = firstX = x0;
              prevY = firstY = y0;
              break
            case 'L':
              if (x0 !== prevX || y0 !== prevY) { //yup, some fonts have zero-length line commands
                lineSegmentsIndex.addLineSegment(prevX, prevY, (prevX = x0), (prevY = y0));
              }
              break
            case 'Q': {
              var prevPoint = {x: prevX, y: prevY};
              for (var i = 1; i < CURVE_POINTS; i++) {
                var nextPoint = pointOnQuadraticBezier(
                  prevX, prevY,
                  x0, y0,
                  x1, y1,
                  i / (CURVE_POINTS - 1)
                );
                lineSegmentsIndex.addLineSegment(prevPoint.x, prevPoint.y, nextPoint.x, nextPoint.y);
                prevPoint = nextPoint;
              }
              prevX = x1;
              prevY = y1;
              break
            }
            case 'C': {
              var prevPoint$1 = {x: prevX, y: prevY};
              for (var i$1 = 1; i$1 < CURVE_POINTS; i$1++) {
                var nextPoint$1 = pointOnCubicBezier(
                  prevX, prevY,
                  x0, y0,
                  x1, y1,
                  x2, y2,
                  i$1 / (CURVE_POINTS - 1)
                );
                lineSegmentsIndex.addLineSegment(prevPoint$1.x, prevPoint$1.y, nextPoint$1.x, nextPoint$1.y);
                prevPoint$1 = nextPoint$1;
              }
              prevX = x2;
              prevY = y2;
              break
            }
            case 'Z':
              if (prevX !== firstX || prevY !== firstY) {
                lineSegmentsIndex.addLineSegment(prevX, prevY, firstX, firstY);
              }
              break
          }
        });

        // For each target SDF texel, find the distance from its center to its nearest line segment,
        // map that distance to an alpha value, and write that alpha to the texel
        for (var sdfX = 0; sdfX < sdfTextureSize; sdfX++) {
          for (var sdfY = 0; sdfY < sdfTextureSize; sdfY++) {
            var signedDist = lineSegmentsIndex.findNearestSignedDistance(
              textureXToFontX(sdfX + 0.5),
              textureYToFontY(sdfY + 0.5),
              fontUnitsMaxDist
            );
            //if (!isFinite(signedDist)) throw 'infinite distance!'
            var alpha = isFinite(signedDist) ? Math.round(255 * (1 + signedDist / fontUnitsMaxDist) * 0.5) : signedDist;
            alpha = Math.max(0, Math.min(255, alpha)); //clamp
            textureData[sdfY * sdfTextureSize + sdfX] = alpha;
          }
        }
      }

      //console.timeEnd('glyphSDF')

      return {
        textureData: textureData,

        renderingBounds: [
          textureMinFontX,
          textureMinFontY,
          textureMaxFontX,
          textureMaxFontY
        ]
      }
    }


    return generateSDF
  }

  /**
   * Creates a self-contained environment for processing text rendering requests.
   *
   * It is important that this function has no external dependencies, so that it can be easily injected
   * into the source for a Worker without requiring a build step or complex dependency loading. Its sole
   * dependency, a `fontParser` implementation function, must be passed in at initialization.
   *
   * @param {function} fontParser - a function that accepts an ArrayBuffer of the font data and returns
   * a standardized structure giving access to the font and its glyphs:
   *   {
   *     unitsPerEm: number,
   *     ascender: number,
   *     descender: number,
   *     forEachGlyph(string, fontSize, letterSpacing, callback) {
   *       //invokes callback for each glyph to render, passing it an object:
   *       callback({
   *         index: number,
   *         unicode: number,
   *         advanceWidth: number,
   *         xMin: number,
   *         yMin: number,
   *         xMax: number,
   *         yMax: number,
   *         pathCommandCount: number,
   *         forEachPathCommand(callback) {
   *           //invokes callback for each path command, with args:
   *           callback(
   *             type: 'M|L|C|Q|Z',
   *             ...args //0 to 6 args depending on the type
   *           )
   *         }
   *       })
   *     }
   *   }
   * @param {function} sdfGenerator - a function that accepts a glyph object and generates an SDF texture
   * from it.
   * @param {Object} config
   * @return {Object}
   */
  function createFontProcessor(fontParser, sdfGenerator, config) {

    var defaultFontUrl = config.defaultFontUrl;


    /**
     * @private
     * Holds the loaded data for all fonts
     *
     * {
     *   fontUrl: {
     *     fontObj: {}, //result of the fontParser
     *     glyphs: {
     *       [glyphIndex]: {
     *         atlasIndex: 0,
     *         glyphObj: {}, //glyph object from the fontParser
     *         renderingBounds: [x0, y0, x1, y1]
     *       },
     *       ...
     *     },
     *     glyphCount: 123
     *   }
     * }
     */
    var fonts = Object.create(null);

    var INF = Infinity;


    /**
     * Load a given font url
     */
    function doLoadFont(url, callback) {
      function tryLoad() {
        var onError = function (err) {
          console.error(("Failure loading font " + url + (url === defaultFontUrl ? '' : '; trying fallback')), err);
          if (url !== defaultFontUrl) {
            url = defaultFontUrl;
            tryLoad();
          }
        };
        try {
          var request = new XMLHttpRequest();
          request.open('get', url, true);
          request.responseType = 'arraybuffer';
          request.onload = function () {
            try {
              var fontObj = fontParser(request.response);
              callback(fontObj);
            } catch (e) {
              onError(e);
            }
          };
          request.onerror = onError;
          request.send();
        } catch(err) {
          onError(err);
        }
      }
      tryLoad();
    }


    /**
     * Load a given font url if needed, invoking a callback when it's loaded. If already
     * loaded, the callback will be called synchronously.
     */
    function loadFont(fontUrl, callback) {
      if (!fontUrl) { fontUrl = defaultFontUrl; }
      var atlas = fonts[fontUrl];
      if (atlas) {
        // if currently loading font, add to callbacks, otherwise execute immediately
        if (atlas.onload) {
          atlas.onload.push(callback);
        } else {
          callback();
        }
      } else {
        var loadingAtlas = fonts[fontUrl] = {onload: [callback]};
        doLoadFont(fontUrl, function (fontObj) {
          atlas = fonts[fontUrl] = {
            fontObj: fontObj,
            glyphs: {},
            glyphCount: 0
          };
          loadingAtlas.onload.forEach(function (cb) { return cb(); });
        });
      }
    }


    /**
     * Get the atlas data for a given font url, loading it from the network and initializing
     * its atlas data objects if necessary.
     */
    function getSdfAtlas(fontUrl, callback) {
      if (!fontUrl) { fontUrl = defaultFontUrl; }
      loadFont(fontUrl, function () {
        callback(fonts[fontUrl]);
      });
    }


    /**
     * Main entry point.
     * Process a text string with given font and formatting parameters, and return all info
     * necessary to render all its glyphs.
     */
    function process(
      ref,
      callback,
      metricsOnly
    ) {
      var text = ref.text; if ( text === void 0 ) text = '';
      var font = ref.font; if ( font === void 0 ) font = defaultFontUrl;
      var fontSize = ref.fontSize; if ( fontSize === void 0 ) fontSize = 1;
      var letterSpacing = ref.letterSpacing; if ( letterSpacing === void 0 ) letterSpacing = 0;
      var lineHeight = ref.lineHeight; if ( lineHeight === void 0 ) lineHeight = 'normal';
      var maxWidth = ref.maxWidth; if ( maxWidth === void 0 ) maxWidth = INF;
      var textAlign = ref.textAlign; if ( textAlign === void 0 ) textAlign = 'left';
      var whiteSpace = ref.whiteSpace; if ( whiteSpace === void 0 ) whiteSpace = 'normal';
      var overflowWrap = ref.overflowWrap; if ( overflowWrap === void 0 ) overflowWrap = 'normal';
      var anchor = ref.anchor;
      if ( metricsOnly === void 0 ) metricsOnly=false;

      getSdfAtlas(font, function (atlas) {
        var fontObj = atlas.fontObj;
        var hasMaxWidth = isFinite(maxWidth);
        var newGlyphs = null;
        var glyphBounds = null;
        var glyphIndices = null;
        var totalBounds = null;
        var lineCount = 0;
        var maxLineWidth = 0;
        var canWrap = whiteSpace !== 'nowrap';

        // Find conversion between native font units and fontSize units; this will already be done
        // for the gx/gy values below but everything else we'll need to convert
        var fontSizeMult = fontSize / fontObj.unitsPerEm;

        // Determine appropriate value for 'normal' line height based on the font's actual metrics
        // TODO this does not guarantee individual glyphs won't exceed the line height, e.g. Roboto; should we use yMin/Max instead?
        if (lineHeight === 'normal') {
          lineHeight = (fontObj.ascender - fontObj.descender) / fontObj.unitsPerEm;
        }

        // Determine line height and leading adjustments
        lineHeight = lineHeight * fontSize;
        var halfLeading = (lineHeight - (fontObj.ascender - fontObj.descender) * fontSizeMult) / 2;

        // Split by hard line breaks
        var lineBlocks = text.split(/\r?\n/).map(function (text) {
          var lineXOffset = 0;

          // Distribute glyphs into lines based on wrapping
          var currentLine = [];
          var lines = [currentLine];
          fontObj.forEachGlyph(text, fontSize, letterSpacing, function (glyphObj, glyphX) {
            var charCode = glyphObj.unicode;
            var char = typeof charCode === 'number' && String.fromCharCode(charCode);
            var glyphWidth = glyphObj.advanceWidth * fontSizeMult;
            var isWhitespace = !!char && /\s/.test(char);

            // If a non-whitespace character overflows the max width, we need to wrap
            if (canWrap && hasMaxWidth && !isWhitespace && glyphX + glyphWidth + lineXOffset > maxWidth && currentLine.length) {
              // If it's the first char after a whitespace, start a new line
              var nextLine;
              if (currentLine[currentLine.length - 1].isWhitespace) {
                nextLine = [];
                lineXOffset = -glyphX;
              } else {
                // Back up looking for a whitespace character to wrap at
                for (var i = currentLine.length; i--;) {
                  // If we got the start of the line there's no soft break point; make hard break if overflowWrap='break-word'
                  if (i === 0 && overflowWrap==='break-word') {
                    nextLine = [];
                    lineXOffset = -glyphX;
                    break
                  }
                  // Found a soft break point; move all chars since it to a new line
                  else if (currentLine[i].isWhitespace) {
                    nextLine = currentLine.splice(i + 1);
                    var adjustX = nextLine[0].x;
                    lineXOffset -= adjustX;
                    for (var j = 0; j < nextLine.length; j++) {
                      nextLine[j].x -= adjustX;
                    }
                    break
                  }
                }
              }
              if (nextLine) {
                // Strip any trailing whitespace characters from the prior line so they don't affect line length
                while (currentLine[currentLine.length - 1].isWhitespace) {
                  currentLine.pop();
                }
                lines.push(currentLine = nextLine);
                maxLineWidth = maxWidth;
              }
            }

            currentLine.push({
              glyphObj: glyphObj,
              x: glyphX + lineXOffset,
              y: 0, //added later
              width: glyphWidth,
              char: char,
              isWhitespace: isWhitespace,
              isEmpty: glyphObj.xMin === glyphObj.xMax || glyphObj.yMin === glyphObj.yMax,
              atlasInfo: null //added later
            });
          });

          // Find max block width after wrapping
          for (var i = 0; i < lines.length && maxLineWidth < maxWidth; i++) {
            var lineGlyphs = lines[i];
            if (lineGlyphs.length) {
              var lastChar = lineGlyphs[lineGlyphs.length - 1];
              maxLineWidth = Math.max(maxLineWidth, lastChar.x + lastChar.width);
            }
          }
          lineCount += lines.length;

          return lines
        });

        if (!metricsOnly) {
          // Process each line, applying alignment offsets, adding each glyph to the atlas, and
          // collecting all renderable glyphs into a single collection.
          var renderableGlyphs = [];
          var lineYOffset = -(fontSize + halfLeading);
          lineBlocks.forEach(function (lines) {
            for (var lineIndex = 0; lineIndex < lines.length; lineIndex++) {
              var lineGlyphs = lines[lineIndex];

              // Ignore empty lines
              if (lineGlyphs.length) {
                // Find x offset for horizontal alignment
                var lineXOffset = 0;
                var lastChar = lineGlyphs[lineGlyphs.length - 1];
                var thisLineWidth = lastChar.x + lastChar.width;
                var whitespaceCount = 0;
                if (textAlign === 'center') {
                  lineXOffset = (maxLineWidth - thisLineWidth) / 2;
                } else if (textAlign === 'right') {
                  lineXOffset = maxLineWidth - thisLineWidth;
                } else if (textAlign === 'justify') {
                  // just count the whitespace characters, and we'll adjust the offsets per character in the next loop
                  for (var i = 0, len = lineGlyphs.length; i < len; i++) {
                    if (lineGlyphs[i].isWhitespace) {
                      whitespaceCount++;
                    }
                  }
                }

                for (var i$1 = 0, len$1 = lineGlyphs.length; i$1 < len$1; i$1++) {
                  var glyphInfo = lineGlyphs[i$1];
                  if (glyphInfo.isWhitespace && textAlign === 'justify' && lineIndex !== lines.length - 1) {
                    lineXOffset += (maxLineWidth - thisLineWidth) / whitespaceCount;
                  }

                  if (!glyphInfo.isWhitespace && !glyphInfo.isEmpty) {
                    var glyphObj = glyphInfo.glyphObj;

                    // If we haven't seen this glyph yet, generate its SDF
                    var glyphAtlasInfo = atlas.glyphs[glyphObj.index];
                    if (!glyphAtlasInfo) {
                      var glyphSDFData = sdfGenerator(glyphObj);

                      // Assign this glyph the next available atlas index
                      glyphSDFData.atlasIndex = atlas.glyphCount++;

                      // Queue it up in the response's newGlyphs list
                      if (!newGlyphs) { newGlyphs = []; }
                      newGlyphs.push(glyphSDFData);

                      // Store its metadata (not the texture) in our atlas info
                      glyphAtlasInfo = atlas.glyphs[glyphObj.index] = {
                        atlasIndex: glyphSDFData.atlasIndex,
                        glyphObj: glyphObj,
                        renderingBounds: glyphSDFData.renderingBounds
                      };
                    }
                    glyphInfo.atlasInfo = glyphAtlasInfo;

                    // Apply position adjustments
                    if (lineXOffset) { glyphInfo.x += lineXOffset; }
                    glyphInfo.y = lineYOffset;

                    renderableGlyphs.push(glyphInfo);
                  }
                }
              }

              // Increment y offset for next line
              lineYOffset -= lineHeight;
            }
          });

          // Find overall position adjustments for anchoring
          var anchorXOffset = 0;
          var anchorYOffset = 0;
          if (anchor) {
            // TODO allow string keywords?
            if (anchor[0]) {
              anchorXOffset = -maxLineWidth * anchor[0];
            }
            if (anchor[1]) {
              anchorYOffset = lineCount * lineHeight * anchor[1];
            }
          }

          // Create the final output for the rendeable glyphs
          glyphBounds = new Float32Array(renderableGlyphs.length * 4);
          glyphIndices = new Float32Array(renderableGlyphs.length);
          totalBounds = [INF, INF, -INF, -INF];
          renderableGlyphs.forEach(function (glyphInfo, i) {
            var ref = glyphInfo.atlasInfo;
            var renderingBounds = ref.renderingBounds;
            var atlasIndex = ref.atlasIndex;
            var x0 = glyphBounds[i * 4] = glyphInfo.x + renderingBounds[0] * fontSizeMult + anchorXOffset;
            var y0 = glyphBounds[i * 4 + 1] = glyphInfo.y + renderingBounds[1] * fontSizeMult + anchorYOffset;
            var x1 = glyphBounds[i * 4 + 2] = glyphInfo.x + renderingBounds[2] * fontSizeMult + anchorXOffset;
            var y1 = glyphBounds[i * 4 + 3] = glyphInfo.y + renderingBounds[3] * fontSizeMult + anchorYOffset;

            if (x0 < totalBounds[0]) { totalBounds[0] = x0; }
            if (y0 < totalBounds[1]) { totalBounds[1] = y0; }
            if (x1 > totalBounds[2]) { totalBounds[2] = x1; }
            if (y1 > totalBounds[3]) { totalBounds[3] = y1; }

            glyphIndices[i] = atlasIndex;
          });
        }

        callback({
          glyphBounds: glyphBounds,
          glyphIndices: glyphIndices,
          totalBounds: totalBounds,
          totalBlockSize: [maxLineWidth, lineCount * lineHeight],
          newGlyphSDFs: newGlyphs
        });
      });
    }


    /**
     * For a given text string and font parameters, determine the resulting block dimensions
     * after wrapping for the given maxWidth.
     * @param args
     * @param callback
     */
    function measure(args, callback) {
      process(args, function (result) {
        callback({
          width: result.totalBlockSize[0],
          height: result.totalBlockSize[1]
        });
      }, true);
    }

    return {
      process: process,
      measure: measure,
      loadFont: loadFont
    }
  }

  // Custom bundle of Typr.js (https://github.com/photopea/Typr.js) for use in troika-3d-text. 
  // Original MIT license applies: https://github.com/photopea/Typr.js/blob/gh-pages/LICENSE

  function typrFactory() {

  var window = self;

  // Begin Typr.js


  var Typr = {};

  Typr.parse = function(buff)
  {
  	var bin = Typr._bin;
  	var data = new Uint8Array(buff);
  	
  	var tag = bin.readASCII(data, 0, 4);  
  	if(tag=="ttcf") {
  		var offset = 4;
  		var majV = bin.readUshort(data, offset);  offset+=2;
  		var minV = bin.readUshort(data, offset);  offset+=2;
  		var numF = bin.readUint  (data, offset);  offset+=4;
  		var fnts = [];
  		for(var i=0; i<numF; i++) {
  			var foff = bin.readUint  (data, offset);  offset+=4;
  			fnts.push(Typr._readFont(data, foff));
  		}
  		return fnts;
  	}
  	else { return [Typr._readFont(data, 0)]; }
  };

  Typr._readFont = function(data, offset) {
  	var bin = Typr._bin;
  	var ooff = offset;
  	
  	var sfnt_version = bin.readFixed(data, offset);
  	offset += 4;
  	var numTables = bin.readUshort(data, offset);
  	offset += 2;
  	var searchRange = bin.readUshort(data, offset);
  	offset += 2;
  	var entrySelector = bin.readUshort(data, offset);
  	offset += 2;
  	var rangeShift = bin.readUshort(data, offset);
  	offset += 2;
  	
  	var tags = [
  		"cmap",
  		"head",
  		"hhea",
  		"maxp",
  		"hmtx",
  		"name",
  		"OS/2",
  		"post",
  		
  		//"cvt",
  		//"fpgm",
  		"loca",
  		"glyf",
  		"kern",
  		
  		//"prep"
  		//"gasp"
  		
  		"CFF ",
  		
  		
  		"GPOS",
  		"GSUB",
  		
  		"SVG " ];
  	
  	var obj = {_data:data, _offset:ooff};
  	//console.log(sfnt_version, numTables, searchRange, entrySelector, rangeShift);
  	
  	var tabs = {};
  	
  	for(var i=0; i<numTables; i++)
  	{
  		var tag = bin.readASCII(data, offset, 4);   offset += 4;
  		var checkSum = bin.readUint(data, offset);  offset += 4;
  		var toffset = bin.readUint(data, offset);   offset += 4;
  		var length = bin.readUint(data, offset);    offset += 4;
  		tabs[tag] = {offset:toffset, length:length};
  		
  		//if(tags.indexOf(tag)==-1) console.log("unknown tag", tag, length);
  	}
  	
  	for(var i=0; i< tags.length; i++)
  	{
  		var t = tags[i];
  		//console.log(t);
  		//if(tabs[t]) console.log(t, tabs[t].offset, tabs[t].length);
  		if(tabs[t]) { obj[t.trim()] = Typr[t.trim()].parse(data, tabs[t].offset, tabs[t].length, obj); }
  	}
  	
  	return obj;
  };

  Typr._tabOffset = function(data, tab, foff)
  {
  	var bin = Typr._bin;
  	var numTables = bin.readUshort(data, foff+4);
  	var offset = foff+12;
  	for(var i=0; i<numTables; i++)
  	{
  		var tag = bin.readASCII(data, offset, 4);   offset += 4;
  		var checkSum = bin.readUint(data, offset);  offset += 4;
  		var toffset = bin.readUint(data, offset);   offset += 4;
  		var length = bin.readUint(data, offset);    offset += 4;
  		if(tag==tab) { return toffset; }
  	}
  	return 0;
  };





  Typr._bin = {
  	readFixed : function(data, o)
  	{
  		return ((data[o]<<8) | data[o+1]) +  (((data[o+2]<<8)|data[o+3])/(256*256+4));
  	},
  	readF2dot14 : function(data, o)
  	{
  		var num = Typr._bin.readShort(data, o);
  		return num / 16384;
  	},
  	readInt : function(buff, p)
  	{
  		//if(p>=buff.length) throw "error";
  		var a = Typr._bin.t.uint8;
  		a[0] = buff[p+3];
  		a[1] = buff[p+2];
  		a[2] = buff[p+1];
  		a[3] = buff[p];
  		return Typr._bin.t.int32[0];
  	},
  	
  	readInt8 : function(buff, p)
  	{
  		//if(p>=buff.length) throw "error";
  		var a = Typr._bin.t.uint8;
  		a[0] = buff[p];
  		return Typr._bin.t.int8[0];
  	},
  	readShort : function(buff, p)
  	{
  		//if(p>=buff.length) throw "error";
  		var a = Typr._bin.t.uint8;
  		a[1] = buff[p]; a[0] = buff[p+1];
  		return Typr._bin.t.int16[0];
  	},
  	readUshort : function(buff, p)
  	{
  		//if(p>=buff.length) throw "error";
  		return (buff[p]<<8) | buff[p+1];
  	},
  	readUshorts : function(buff, p, len)
  	{
  		var arr = [];
  		for(var i=0; i<len; i++) { arr.push(Typr._bin.readUshort(buff, p+i*2)); }
  		return arr;
  	},
  	readUint : function(buff, p)
  	{
  		//if(p>=buff.length) throw "error";
  		var a = Typr._bin.t.uint8;
  		a[3] = buff[p];  a[2] = buff[p+1];  a[1] = buff[p+2];  a[0] = buff[p+3];
  		return Typr._bin.t.uint32[0];
  	},
  	readUint64 : function(buff, p)
  	{
  		//if(p>=buff.length) throw "error";
  		return (Typr._bin.readUint(buff, p)*(0xffffffff+1)) + Typr._bin.readUint(buff, p+4);
  	},
  	readASCII : function(buff, p, l)	// l : length in Characters (not Bytes)
  	{
  		//if(p>=buff.length) throw "error";
  		var s = "";
  		for(var i = 0; i < l; i++) { s += String.fromCharCode(buff[p+i]); }
  		return s;
  	},
  	readUnicode : function(buff, p, l)
  	{
  		//if(p>=buff.length) throw "error";
  		var s = "";
  		for(var i = 0; i < l; i++)	
  		{
  			var c = (buff[p++]<<8) | buff[p++];
  			s += String.fromCharCode(c);
  		}
  		return s;
  	},
  	_tdec : window["TextDecoder"] ? new window["TextDecoder"]() : null,
  	readUTF8 : function(buff, p, l) {
  		var tdec = Typr._bin._tdec;
  		if(tdec && p==0 && l==buff.length) { return tdec["decode"](buff); }
  		return Typr._bin.readASCII(buff,p,l);
  	},
  	readBytes : function(buff, p, l)
  	{
  		//if(p>=buff.length) throw "error";
  		var arr = [];
  		for(var i=0; i<l; i++) { arr.push(buff[p+i]); }
  		return arr;
  	},
  	readASCIIArray : function(buff, p, l)	// l : length in Characters (not Bytes)
  	{
  		//if(p>=buff.length) throw "error";
  		var s = [];
  		for(var i = 0; i < l; i++)	
  			{ s.push(String.fromCharCode(buff[p+i])); }
  		return s;
  	}
  };

  Typr._bin.t = {
  	buff: new ArrayBuffer(8),
  };
  Typr._bin.t.int8   = new Int8Array  (Typr._bin.t.buff);
  Typr._bin.t.uint8  = new Uint8Array (Typr._bin.t.buff);
  Typr._bin.t.int16  = new Int16Array (Typr._bin.t.buff);
  Typr._bin.t.uint16 = new Uint16Array(Typr._bin.t.buff);
  Typr._bin.t.int32  = new Int32Array (Typr._bin.t.buff);
  Typr._bin.t.uint32 = new Uint32Array(Typr._bin.t.buff);





  // OpenType Layout Common Table Formats

  Typr._lctf = {};

  Typr._lctf.parse = function(data, offset, length, font, subt)
  {
  	var bin = Typr._bin;
  	var obj = {};
  	var offset0 = offset;
  	var tableVersion = bin.readFixed(data, offset);  offset += 4;
  	
  	var offScriptList  = bin.readUshort(data, offset);  offset += 2;
  	var offFeatureList = bin.readUshort(data, offset);  offset += 2;
  	var offLookupList  = bin.readUshort(data, offset);  offset += 2;
  	
  	
  	obj.scriptList  = Typr._lctf.readScriptList (data, offset0 + offScriptList);
  	obj.featureList = Typr._lctf.readFeatureList(data, offset0 + offFeatureList);
  	obj.lookupList  = Typr._lctf.readLookupList (data, offset0 + offLookupList, subt);
  	
  	return obj;
  };

  Typr._lctf.readLookupList = function(data, offset, subt)
  {
  	var bin = Typr._bin;
  	var offset0 = offset;
  	var obj = [];
  	var count = bin.readUshort(data, offset);  offset+=2;
  	for(var i=0; i<count; i++) 
  	{
  		var noff = bin.readUshort(data, offset);  offset+=2;
  		var lut = Typr._lctf.readLookupTable(data, offset0 + noff, subt);
  		obj.push(lut);
  	}
  	return obj;
  };

  Typr._lctf.readLookupTable = function(data, offset, subt)
  {
  	//console.log("Parsing lookup table", offset);
  	var bin = Typr._bin;
  	var offset0 = offset;
  	var obj = {tabs:[]};
  	
  	obj.ltype = bin.readUshort(data, offset);  offset+=2;
  	obj.flag  = bin.readUshort(data, offset);  offset+=2;
  	var cnt   = bin.readUshort(data, offset);  offset+=2;
  	
  	for(var i=0; i<cnt; i++)
  	{
  		var noff = bin.readUshort(data, offset);  offset+=2;
  		var tab = subt(data, obj.ltype, offset0 + noff);
  		//console.log(obj.type, tab);
  		obj.tabs.push(tab);
  	}
  	return obj;
  };

  Typr._lctf.numOfOnes = function(n)
  {
  	var num = 0;
  	for(var i=0; i<32; i++) { if(((n>>>i)&1) != 0) { num++; } }
  	return num;
  };

  Typr._lctf.readClassDef = function(data, offset)
  {
  	var bin = Typr._bin;
  	var obj = [];
  	var format = bin.readUshort(data, offset);  offset+=2;
  	if(format==1) 
  	{
  		var startGlyph  = bin.readUshort(data, offset);  offset+=2;
  		var glyphCount  = bin.readUshort(data, offset);  offset+=2;
  		for(var i=0; i<glyphCount; i++)
  		{
  			obj.push(startGlyph+i);
  			obj.push(startGlyph+i);
  			obj.push(bin.readUshort(data, offset));  offset+=2;
  		}
  	}
  	if(format==2)
  	{
  		var count = bin.readUshort(data, offset);  offset+=2;
  		for(var i=0; i<count; i++)
  		{
  			obj.push(bin.readUshort(data, offset));  offset+=2;
  			obj.push(bin.readUshort(data, offset));  offset+=2;
  			obj.push(bin.readUshort(data, offset));  offset+=2;
  		}
  	}
  	return obj;
  };
  Typr._lctf.getInterval = function(tab, val)
  {
  	for(var i=0; i<tab.length; i+=3)
  	{
  		var start = tab[i], end = tab[i+1], index = tab[i+2];
  		if(start<=val && val<=end) { return i; }
  	}
  	return -1;
  };


  Typr._lctf.readCoverage = function(data, offset)
  {
  	var bin = Typr._bin;
  	var cvg = {};
  	cvg.fmt   = bin.readUshort(data, offset);  offset+=2;
  	var count = bin.readUshort(data, offset);  offset+=2;
  	//console.log("parsing coverage", offset-4, format, count);
  	if(cvg.fmt==1) { cvg.tab = bin.readUshorts(data, offset, count); } 
  	if(cvg.fmt==2) { cvg.tab = bin.readUshorts(data, offset, count*3); }
  	return cvg;
  };

  Typr._lctf.coverageIndex = function(cvg, val)
  {
  	var tab = cvg.tab;
  	if(cvg.fmt==1) { return tab.indexOf(val); }
  	if(cvg.fmt==2) {
  		var ind = Typr._lctf.getInterval(tab, val);
  		if(ind!=-1) { return tab[ind+2] + (val - tab[ind]); }
  	}
  	return -1;
  };

  Typr._lctf.readFeatureList = function(data, offset)
  {
  	var bin = Typr._bin;
  	var offset0 = offset;
  	var obj = [];
  	
  	var count = bin.readUshort(data, offset);  offset+=2;
  	
  	for(var i=0; i<count; i++)
  	{
  		var tag = bin.readASCII(data, offset, 4);  offset+=4;
  		var noff = bin.readUshort(data, offset);  offset+=2;
  		obj.push({tag: tag.trim(), tab:Typr._lctf.readFeatureTable(data, offset0 + noff)});
  	}
  	return obj;
  };

  Typr._lctf.readFeatureTable = function(data, offset)
  {
  	var bin = Typr._bin;
  	
  	var featureParams = bin.readUshort(data, offset);  offset+=2;	// = 0
  	var lookupCount = bin.readUshort(data, offset);  offset+=2;
  	
  	var indices = [];
  	for(var i=0; i<lookupCount; i++) { indices.push(bin.readUshort(data, offset+2*i)); }
  	return indices;
  };


  Typr._lctf.readScriptList = function(data, offset)
  {
  	var bin = Typr._bin;
  	var offset0 = offset;
  	var obj = {};
  	
  	var count = bin.readUshort(data, offset);  offset+=2;
  	
  	for(var i=0; i<count; i++)
  	{
  		var tag = bin.readASCII(data, offset, 4);  offset+=4;
  		var noff = bin.readUshort(data, offset);  offset+=2;
  		obj[tag.trim()] = Typr._lctf.readScriptTable(data, offset0 + noff);
  	}
  	return obj;
  };

  Typr._lctf.readScriptTable = function(data, offset)
  {
  	var bin = Typr._bin;
  	var offset0 = offset;
  	var obj = {};
  	
  	var defLangSysOff = bin.readUshort(data, offset);  offset+=2;
  	obj.default = Typr._lctf.readLangSysTable(data, offset0 + defLangSysOff);
  	
  	var langSysCount = bin.readUshort(data, offset);  offset+=2;
  	
  	for(var i=0; i<langSysCount; i++)
  	{
  		var tag = bin.readASCII(data, offset, 4);  offset+=4;
  		var langSysOff = bin.readUshort(data, offset);  offset+=2;
  		obj[tag.trim()] = Typr._lctf.readLangSysTable(data, offset0 + langSysOff);
  	}
  	return obj;
  };

  Typr._lctf.readLangSysTable = function(data, offset)
  {
  	var bin = Typr._bin;
  	var obj = {};
  	
  	var lookupOrder = bin.readUshort(data, offset);  offset+=2;
  	//if(lookupOrder!=0)  throw "lookupOrder not 0";
  	obj.reqFeature = bin.readUshort(data, offset);  offset+=2;
  	//if(obj.reqFeature != 0xffff) throw "reqFeatureIndex != 0xffff";
  	
  	//console.log(lookupOrder, obj.reqFeature);
  	
  	var featureCount = bin.readUshort(data, offset);  offset+=2;
  	obj.features = bin.readUshorts(data, offset, featureCount);
  	return obj;
  };

  	Typr.CFF = {};
  	Typr.CFF.parse = function(data, offset, length)
  	{
  		var bin = Typr._bin;
  		
  		data = new Uint8Array(data.buffer, offset, length);
  		offset = 0;
  		
  		// Header
  		var major = data[offset];  offset++;
  		var minor = data[offset];  offset++;
  		var hdrSize = data[offset];  offset++;
  		var offsize = data[offset];  offset++;
  		//console.log(major, minor, hdrSize, offsize);
  		
  		// Name INDEX
  		var ninds = [];
  		offset = Typr.CFF.readIndex(data, offset, ninds);
  		var names = [];
  		
  		for(var i=0; i<ninds.length-1; i++) { names.push(bin.readASCII(data, offset+ninds[i], ninds[i+1]-ninds[i])); }
  		offset += ninds[ninds.length-1];
  		
  		
  		// Top DICT INDEX
  		var tdinds = [];
  		offset = Typr.CFF.readIndex(data, offset, tdinds);  //console.log(tdinds);
  		// Top DICT Data
  		var topDicts = [];
  		for(var i=0; i<tdinds.length-1; i++) { topDicts.push( Typr.CFF.readDict(data, offset+tdinds[i], offset+tdinds[i+1]) ); }
  		offset += tdinds[tdinds.length-1];
  		var topdict = topDicts[0];
  		//console.log(topdict);
  		
  		// String INDEX
  		var sinds = [];
  		offset = Typr.CFF.readIndex(data, offset, sinds);
  		// String Data
  		var strings = [];
  		for(var i=0; i<sinds.length-1; i++) { strings.push(bin.readASCII(data, offset+sinds[i], sinds[i+1]-sinds[i])); }
  		offset += sinds[sinds.length-1];
  		
  		// Global Subr INDEX  (subroutines)		
  		Typr.CFF.readSubrs(data, offset, topdict);
  		
  		// charstrings
  		if(topdict.CharStrings)
  		{
  			offset = topdict.CharStrings;
  			var sinds = [];
  			offset = Typr.CFF.readIndex(data, offset, sinds);
  			
  			var cstr = [];
  			for(var i=0; i<sinds.length-1; i++) { cstr.push(bin.readBytes(data, offset+sinds[i], sinds[i+1]-sinds[i])); }
  			//offset += sinds[sinds.length-1];
  			topdict.CharStrings = cstr;
  			//console.log(topdict.CharStrings);
  		}
  		
  		// CID font
  		if(topdict.ROS) {
  			offset = topdict.FDArray;
  			var fdind = [];
  			offset = Typr.CFF.readIndex(data, offset, fdind);
  			
  			topdict.FDArray = [];
  			for(var i=0; i<fdind.length-1; i++) {
  				var dict = Typr.CFF.readDict(data, offset+fdind[i], offset+fdind[i+1]);
  				Typr.CFF._readFDict(data, dict, strings);
  				topdict.FDArray.push( dict );
  			}
  			offset += fdind[fdind.length-1];
  			
  			offset = topdict.FDSelect;
  			topdict.FDSelect = [];
  			var fmt = data[offset];  offset++;
  			if(fmt==3) {
  				var rns = bin.readUshort(data, offset);  offset+=2;
  				for(var i=0; i<rns+1; i++) {
  					topdict.FDSelect.push(bin.readUshort(data, offset), data[offset+2]);  offset+=3;
  				}
  			}
  			else { throw fmt; }
  		}
  		
  		// Encoding
  		if(topdict.Encoding) { topdict.Encoding = Typr.CFF.readEncoding(data, topdict.Encoding, topdict.CharStrings.length); }
  		
  		// charset
  		if(topdict.charset ) { topdict.charset  = Typr.CFF.readCharset (data, topdict.charset , topdict.CharStrings.length); }
  		
  		Typr.CFF._readFDict(data, topdict, strings);
  		return topdict;
  	};
  	Typr.CFF._readFDict = function(data, dict, ss) {
  		var offset;
  		if(dict.Private) {
  			offset = dict.Private[1];
  			dict.Private = Typr.CFF.readDict(data, offset, offset+dict.Private[0]);
  			if(dict.Private.Subrs)  { Typr.CFF.readSubrs(data, offset+dict.Private.Subrs, dict.Private); }
  		}
  		for(var p in dict) { if(["FamilyName","FontName","FullName","Notice","version","Copyright"].indexOf(p)!=-1)  { dict[p]=ss[dict[p] -426 + 35]; } }
  	};
  	
  	Typr.CFF.readSubrs = function(data, offset, obj)
  	{
  		var bin = Typr._bin;
  		var gsubinds = [];
  		offset = Typr.CFF.readIndex(data, offset, gsubinds);
  		
  		var bias, nSubrs = gsubinds.length;
  		if (nSubrs <  1240) { bias = 107; }
  		else if (nSubrs < 33900) { bias = 1131; }
  		else { bias = 32768; }
  		obj.Bias = bias;
  		
  		obj.Subrs = [];
  		for(var i=0; i<gsubinds.length-1; i++) { obj.Subrs.push(bin.readBytes(data, offset+gsubinds[i], gsubinds[i+1]-gsubinds[i])); }
  		//offset += gsubinds[gsubinds.length-1];
  	};
  	
  	Typr.CFF.tableSE = [
        0,   0,   0,   0,   0,   0,   0,   0,
        0,   0,   0,   0,   0,   0,   0,   0,
        0,   0,   0,   0,   0,   0,   0,   0,
        0,   0,   0,   0,   0,   0,   0,   0,
        1,   2,   3,   4,   5,   6,   7,   8,
        9,  10,  11,  12,  13,  14,  15,  16,
       17,  18,  19,  20,  21,  22,  23,  24,
       25,  26,  27,  28,  29,  30,  31,  32,
       33,  34,  35,  36,  37,  38,  39,  40,
       41,  42,  43,  44,  45,  46,  47,  48,
       49,  50,  51,  52,  53,  54,  55,  56,
       57,  58,  59,  60,  61,  62,  63,  64,
       65,  66,  67,  68,  69,  70,  71,  72,
       73,  74,  75,  76,  77,  78,  79,  80,
       81,  82,  83,  84,  85,  86,  87,  88,
       89,  90,  91,  92,  93,  94,  95,   0,
        0,   0,   0,   0,   0,   0,   0,   0,
        0,   0,   0,   0,   0,   0,   0,   0,
        0,   0,   0,   0,   0,   0,   0,   0,
        0,   0,   0,   0,   0,   0,   0,   0,
        0,  96,  97,  98,  99, 100, 101, 102,
      103, 104, 105, 106, 107, 108, 109, 110,
        0, 111, 112, 113, 114,   0, 115, 116,
      117, 118, 119, 120, 121, 122,   0, 123,
        0, 124, 125, 126, 127, 128, 129, 130,
      131,   0, 132, 133,   0, 134, 135, 136,
      137,   0,   0,   0,   0,   0,   0,   0,
        0,   0,   0,   0,   0,   0,   0,   0,
        0, 138,   0, 139,   0,   0,   0,   0,
      140, 141, 142, 143,   0,   0,   0,   0,
        0, 144,   0,   0,   0, 145,   0,   0,
      146, 147, 148, 149,   0,   0,   0,   0
    ];
    
  	Typr.CFF.glyphByUnicode = function(cff, code)
  	{
  		for(var i=0; i<cff.charset.length; i++) { if(cff.charset[i]==code) { return i; } }
  		return -1;
  	};
  	
  	Typr.CFF.glyphBySE = function(cff, charcode)	// glyph by standard encoding
  	{
  		if ( charcode < 0 || charcode > 255 ) { return -1; }
  		return Typr.CFF.glyphByUnicode(cff, Typr.CFF.tableSE[charcode]);		
  	};
  	
  	Typr.CFF.readEncoding = function(data, offset, num)
  	{
  		var bin = Typr._bin;
  		
  		var array = ['.notdef'];
  		var format = data[offset];  offset++;
  		//console.log("Encoding");
  		//console.log(format);
  		
  		if(format==0)
  		{
  			var nCodes = data[offset];  offset++;
  			for(var i=0; i<nCodes; i++)  { array.push(data[offset+i]); }
  		}
  		/*
  		else if(format==1 || format==2)
  		{
  			while(charset.length<num)
  			{
  				var first = bin.readUshort(data, offset);  offset+=2;
  				var nLeft=0;
  				if(format==1) {  nLeft = data[offset];  offset++;  }
  				else          {  nLeft = bin.readUshort(data, offset);  offset+=2;  }
  				for(var i=0; i<=nLeft; i++)  {  charset.push(first);  first++;  }
  			}
  		}
  		*/
  		else { throw "error: unknown encoding format: " + format; }
  		
  		return array;
  	};

  	Typr.CFF.readCharset = function(data, offset, num)
  	{
  		var bin = Typr._bin;
  		
  		var charset = ['.notdef'];
  		var format = data[offset];  offset++;
  		
  		if(format==0)
  		{
  			for(var i=0; i<num; i++) 
  			{
  				var first = bin.readUshort(data, offset);  offset+=2;
  				charset.push(first);
  			}
  		}
  		else if(format==1 || format==2)
  		{
  			while(charset.length<num)
  			{
  				var first = bin.readUshort(data, offset);  offset+=2;
  				var nLeft=0;
  				if(format==1) {  nLeft = data[offset];  offset++;  }
  				else          {  nLeft = bin.readUshort(data, offset);  offset+=2;  }
  				for(var i=0; i<=nLeft; i++)  {  charset.push(first);  first++;  }
  			}
  		}
  		else { throw "error: format: " + format; }
  		
  		return charset;
  	};

  	Typr.CFF.readIndex = function(data, offset, inds)
  	{
  		var bin = Typr._bin;
  		
  		var count = bin.readUshort(data, offset)+1;  offset+=2;
  		var offsize = data[offset];  offset++;
  		
  		if     (offsize==1) { for(var i=0; i<count; i++) { inds.push( data[offset+i] ); } }
  		else if(offsize==2) { for(var i=0; i<count; i++) { inds.push( bin.readUshort(data, offset+i*2) ); } }
  		else if(offsize==3) { for(var i=0; i<count; i++) { inds.push( bin.readUint  (data, offset+i*3 - 1) & 0x00ffffff ); } }
  		else if(count!=1) { throw "unsupported offset size: " + offsize + ", count: " + count; }
  		
  		offset += count*offsize;
  		return offset-1;
  	};
  	
  	Typr.CFF.getCharString = function(data, offset, o)
  	{
  		var bin = Typr._bin;
  		
  		var b0 = data[offset], b1 = data[offset+1], b2 = data[offset+2], b3 = data[offset+3], b4=data[offset+4];
  		var vs = 1;
  		var op=null, val=null;
  		// operand
  		if(b0<=20) { op = b0;  vs=1;  }
  		if(b0==12) { op = b0*100+b1;  vs=2;  }
  		//if(b0==19 || b0==20) { op = b0/*+" "+b1*/;  vs=2; }
  		if(21 <=b0 && b0<= 27) { op = b0;  vs=1; }
  		if(b0==28) { val = bin.readShort(data,offset+1);  vs=3; }
  		if(29 <=b0 && b0<= 31) { op = b0;  vs=1; }
  		if(32 <=b0 && b0<=246) { val = b0-139;  vs=1; }
  		if(247<=b0 && b0<=250) { val = (b0-247)*256+b1+108;  vs=2; }
  		if(251<=b0 && b0<=254) { val =-(b0-251)*256-b1-108;  vs=2; }
  		if(b0==255) {  val = bin.readInt(data, offset+1)/0xffff;  vs=5;   }
  		
  		o.val = val!=null ? val : "o"+op;
  		o.size = vs;
  	};
  	
  	Typr.CFF.readCharString = function(data, offset, length)
  	{
  		var end = offset + length;
  		var bin = Typr._bin;
  		var arr = [];
  		
  		while(offset<end)
  		{
  			var b0 = data[offset], b1 = data[offset+1], b2 = data[offset+2], b3 = data[offset+3], b4=data[offset+4];
  			var vs = 1;
  			var op=null, val=null;
  			// operand
  			if(b0<=20) { op = b0;  vs=1;  }
  			if(b0==12) { op = b0*100+b1;  vs=2;  }
  			if(b0==19 || b0==20) { op = b0/*+" "+b1*/;  vs=2; }
  			if(21 <=b0 && b0<= 27) { op = b0;  vs=1; }
  			if(b0==28) { val = bin.readShort(data,offset+1);  vs=3; }
  			if(29 <=b0 && b0<= 31) { op = b0;  vs=1; }
  			if(32 <=b0 && b0<=246) { val = b0-139;  vs=1; }
  			if(247<=b0 && b0<=250) { val = (b0-247)*256+b1+108;  vs=2; }
  			if(251<=b0 && b0<=254) { val =-(b0-251)*256-b1-108;  vs=2; }
  			if(b0==255) {  val = bin.readInt(data, offset+1)/0xffff;  vs=5;   }
  			
  			arr.push(val!=null ? val : "o"+op);
  			offset += vs;	

  			//var cv = arr[arr.length-1];
  			//if(cv==undefined) throw "error";
  			//console.log()
  		}	
  		return arr;
  	};

  	Typr.CFF.readDict = function(data, offset, end)
  	{
  		var bin = Typr._bin;
  		//var dict = [];
  		var dict = {};
  		var carr = [];
  		
  		while(offset<end)
  		{
  			var b0 = data[offset], b1 = data[offset+1], b2 = data[offset+2], b3 = data[offset+3], b4=data[offset+4];
  			var vs = 1;
  			var key=null, val=null;
  			// operand
  			if(b0==28) { val = bin.readShort(data,offset+1);  vs=3; }
  			if(b0==29) { val = bin.readInt  (data,offset+1);  vs=5; }
  			if(32 <=b0 && b0<=246) { val = b0-139;  vs=1; }
  			if(247<=b0 && b0<=250) { val = (b0-247)*256+b1+108;  vs=2; }
  			if(251<=b0 && b0<=254) { val =-(b0-251)*256-b1-108;  vs=2; }
  			if(b0==255) {  val = bin.readInt(data, offset+1)/0xffff;  vs=5;  throw "unknown number";  }
  			
  			if(b0==30) 
  			{  
  				var nibs = [];
  				vs = 1;
  				while(true)
  				{
  					var b = data[offset+vs];  vs++;
  					var nib0 = b>>4, nib1 = b&0xf;
  					if(nib0 != 0xf) { nibs.push(nib0); }  if(nib1!=0xf) { nibs.push(nib1); }
  					if(nib1==0xf) { break; }
  				}
  				var s = "";
  				var chars = [0,1,2,3,4,5,6,7,8,9,".","e","e-","reserved","-","endOfNumber"];
  				for(var i=0; i<nibs.length; i++) { s += chars[nibs[i]]; }
  				//console.log(nibs);
  				val = parseFloat(s);
  			}
  			
  			if(b0<=21)	// operator
  			{
  				var keys = ["version", "Notice", "FullName", "FamilyName", "Weight", "FontBBox", "BlueValues", "OtherBlues", "FamilyBlues","FamilyOtherBlues",
  					"StdHW", "StdVW", "escape", "UniqueID", "XUID", "charset", "Encoding", "CharStrings", "Private", "Subrs", 
  					"defaultWidthX", "nominalWidthX"];
  					
  				key = keys[b0];  vs=1;
  				if(b0==12) { 
  					var keys = [ "Copyright", "isFixedPitch", "ItalicAngle", "UnderlinePosition", "UnderlineThickness", "PaintType", "CharstringType", "FontMatrix", "StrokeWidth", "BlueScale",
  					"BlueShift", "BlueFuzz", "StemSnapH", "StemSnapV", "ForceBold", 0,0, "LanguageGroup", "ExpansionFactor", "initialRandomSeed",
  					"SyntheticBase", "PostScript", "BaseFontName", "BaseFontBlend", 0,0,0,0,0,0, 
  					"ROS", "CIDFontVersion", "CIDFontRevision", "CIDFontType", "CIDCount", "UIDBase", "FDArray", "FDSelect", "FontName"];
  					key = keys[b1];  vs=2; 
  				}
  			}
  			
  			if(key!=null) {  dict[key] = carr.length==1 ? carr[0] : carr;  carr=[]; }
  			else  { carr.push(val); }  
  			
  			offset += vs;		
  		}	
  		return dict;
  	};


  Typr.cmap = {};
  Typr.cmap.parse = function(data, offset, length)
  {
  	data = new Uint8Array(data.buffer, offset, length);
  	offset = 0;
  	var bin = Typr._bin;
  	var obj = {};
  	var version   = bin.readUshort(data, offset);  offset += 2;
  	var numTables = bin.readUshort(data, offset);  offset += 2;
  	
  	//console.log(version, numTables);
  	
  	var offs = [];
  	obj.tables = [];
  	
  	
  	for(var i=0; i<numTables; i++)
  	{
  		var platformID = bin.readUshort(data, offset);  offset += 2;
  		var encodingID = bin.readUshort(data, offset);  offset += 2;
  		var noffset = bin.readUint(data, offset);       offset += 4;
  		
  		var id = "p"+platformID+"e"+encodingID;
  		
  		//console.log("cmap subtable", platformID, encodingID, noffset);
  		
  		
  		var tind = offs.indexOf(noffset);
  		
  		if(tind==-1)
  		{
  			tind = obj.tables.length;
  			var subt;
  			offs.push(noffset);
  			var format = bin.readUshort(data, noffset);
  			if     (format== 0) { subt = Typr.cmap.parse0(data, noffset); }
  			else if(format== 4) { subt = Typr.cmap.parse4(data, noffset); }
  			else if(format== 6) { subt = Typr.cmap.parse6(data, noffset); }
  			else if(format==12) { subt = Typr.cmap.parse12(data,noffset); }
  			else { console.log("unknown format: "+format, platformID, encodingID, noffset); }
  			obj.tables.push(subt);
  		}
  		
  		if(obj[id]!=null) { throw "multiple tables for one platform+encoding"; }
  		obj[id] = tind;
  	}
  	return obj;
  };

  Typr.cmap.parse0 = function(data, offset)
  {
  	var bin = Typr._bin;
  	var obj = {};
  	obj.format = bin.readUshort(data, offset);  offset += 2;
  	var len    = bin.readUshort(data, offset);  offset += 2;
  	var lang   = bin.readUshort(data, offset);  offset += 2;
  	obj.map = [];
  	for(var i=0; i<len-6; i++) { obj.map.push(data[offset+i]); }
  	return obj;
  };

  Typr.cmap.parse4 = function(data, offset)
  {
  	var bin = Typr._bin;
  	var offset0 = offset;
  	var obj = {};
  	
  	obj.format = bin.readUshort(data, offset);  offset+=2;
  	var length = bin.readUshort(data, offset);  offset+=2;
  	var language = bin.readUshort(data, offset);  offset+=2;
  	var segCountX2 = bin.readUshort(data, offset);  offset+=2;
  	var segCount = segCountX2/2;
  	obj.searchRange = bin.readUshort(data, offset);  offset+=2;
  	obj.entrySelector = bin.readUshort(data, offset);  offset+=2;
  	obj.rangeShift = bin.readUshort(data, offset);  offset+=2;
  	obj.endCount   = bin.readUshorts(data, offset, segCount);  offset += segCount*2;
  	offset+=2;
  	obj.startCount = bin.readUshorts(data, offset, segCount);  offset += segCount*2;
  	obj.idDelta = [];
  	for(var i=0; i<segCount; i++) {obj.idDelta.push(bin.readShort(data, offset));  offset+=2;}
  	obj.idRangeOffset = bin.readUshorts(data, offset, segCount);  offset += segCount*2;
  	obj.glyphIdArray = [];
  	while(offset< offset0+length) {obj.glyphIdArray.push(bin.readUshort(data, offset));  offset+=2;}
  	return obj;
  };

  Typr.cmap.parse6 = function(data, offset)
  {
  	var bin = Typr._bin;
  	var obj = {};
  	
  	obj.format = bin.readUshort(data, offset);  offset+=2;
  	var length = bin.readUshort(data, offset);  offset+=2;
  	var language = bin.readUshort(data, offset);  offset+=2;
  	obj.firstCode = bin.readUshort(data, offset);  offset+=2;
  	var entryCount = bin.readUshort(data, offset);  offset+=2;
  	obj.glyphIdArray = [];
  	for(var i=0; i<entryCount; i++) {obj.glyphIdArray.push(bin.readUshort(data, offset));  offset+=2;}
  	
  	return obj;
  };

  Typr.cmap.parse12 = function(data, offset)
  {
  	var bin = Typr._bin;
  	var obj = {};
  	
  	obj.format = bin.readUshort(data, offset);  offset+=2;
  	offset += 2;
  	var length = bin.readUint(data, offset);  offset+=4;
  	var lang   = bin.readUint(data, offset);  offset+=4;
  	var nGroups= bin.readUint(data, offset);  offset+=4;
  	obj.groups = [];
  	
  	for(var i=0; i<nGroups; i++)  
  	{
  		var off = offset + i * 12;
  		var startCharCode = bin.readUint(data, off+0);
  		var endCharCode   = bin.readUint(data, off+4);
  		var startGlyphID  = bin.readUint(data, off+8);
  		obj.groups.push([  startCharCode, endCharCode, startGlyphID  ]);
  	}
  	return obj;
  };

  Typr.glyf = {};
  Typr.glyf.parse = function(data, offset, length, font)
  {
  	var obj = [];
  	for(var g=0; g<font.maxp.numGlyphs; g++) { obj.push(null); }
  	return obj;
  };

  Typr.glyf._parseGlyf = function(font, g)
  {
  	var bin = Typr._bin;
  	var data = font._data;
  	
  	var offset = Typr._tabOffset(data, "glyf", font._offset) + font.loca[g];
  		
  	if(font.loca[g]==font.loca[g+1]) { return null; }
  		
  	var gl = {};
  		
  	gl.noc  = bin.readShort(data, offset);  offset+=2;		// number of contours
  	gl.xMin = bin.readShort(data, offset);  offset+=2;
  	gl.yMin = bin.readShort(data, offset);  offset+=2;
  	gl.xMax = bin.readShort(data, offset);  offset+=2;
  	gl.yMax = bin.readShort(data, offset);  offset+=2;
  	
  	if(gl.xMin>=gl.xMax || gl.yMin>=gl.yMax) { return null; }
  		
  	if(gl.noc>0)
  	{
  		gl.endPts = [];
  		for(var i=0; i<gl.noc; i++) { gl.endPts.push(bin.readUshort(data,offset)); offset+=2; }
  		
  		var instructionLength = bin.readUshort(data,offset); offset+=2;
  		if((data.length-offset)<instructionLength) { return null; }
  		gl.instructions = bin.readBytes(data, offset, instructionLength);   offset+=instructionLength;
  		
  		var crdnum = gl.endPts[gl.noc-1]+1;
  		gl.flags = [];
  		for(var i=0; i<crdnum; i++ ) 
  		{ 
  			var flag = data[offset];  offset++; 
  			gl.flags.push(flag); 
  			if((flag&8)!=0)
  			{
  				var rep = data[offset];  offset++;
  				for(var j=0; j<rep; j++) { gl.flags.push(flag); i++; }
  			}
  		}
  		gl.xs = [];
  		for(var i=0; i<crdnum; i++) {
  			var i8=((gl.flags[i]&2)!=0), same=((gl.flags[i]&16)!=0);  
  			if(i8) { gl.xs.push(same ? data[offset] : -data[offset]);  offset++; }
  			else
  			{
  				if(same) { gl.xs.push(0); }
  				else { gl.xs.push(bin.readShort(data, offset));  offset+=2; }
  			}
  		}
  		gl.ys = [];
  		for(var i=0; i<crdnum; i++) {
  			var i8=((gl.flags[i]&4)!=0), same=((gl.flags[i]&32)!=0);  
  			if(i8) { gl.ys.push(same ? data[offset] : -data[offset]);  offset++; }
  			else
  			{
  				if(same) { gl.ys.push(0); }
  				else { gl.ys.push(bin.readShort(data, offset));  offset+=2; }
  			}
  		}
  		var x = 0, y = 0;
  		for(var i=0; i<crdnum; i++) { x += gl.xs[i]; y += gl.ys[i];  gl.xs[i]=x;  gl.ys[i]=y; }
  		//console.log(endPtsOfContours, instructionLength, instructions, flags, xCoordinates, yCoordinates);
  	}
  	else
  	{
  		var ARG_1_AND_2_ARE_WORDS	= 1<<0;
  		var ARGS_ARE_XY_VALUES		= 1<<1;
  		var WE_HAVE_A_SCALE			= 1<<3;
  		var MORE_COMPONENTS			= 1<<5;
  		var WE_HAVE_AN_X_AND_Y_SCALE= 1<<6;
  		var WE_HAVE_A_TWO_BY_TWO	= 1<<7;
  		var WE_HAVE_INSTRUCTIONS	= 1<<8;
  		
  		gl.parts = [];
  		var flags;
  		do {
  			flags = bin.readUshort(data, offset);  offset += 2;
  			var part = { m:{a:1,b:0,c:0,d:1,tx:0,ty:0}, p1:-1, p2:-1 };  gl.parts.push(part);
  			part.glyphIndex = bin.readUshort(data, offset);  offset += 2;
  			if ( flags & ARG_1_AND_2_ARE_WORDS) {
  				var arg1 = bin.readShort(data, offset);  offset += 2;
  				var arg2 = bin.readShort(data, offset);  offset += 2;
  			} else {
  				var arg1 = bin.readInt8(data, offset);  offset ++;
  				var arg2 = bin.readInt8(data, offset);  offset ++;
  			}
  			
  			if(flags & ARGS_ARE_XY_VALUES) { part.m.tx = arg1;  part.m.ty = arg2; }
  			else  {  part.p1=arg1;  part.p2=arg2;  }
  			//part.m.tx = arg1;  part.m.ty = arg2;
  			//else { throw "params are not XY values"; }
  			
  			if ( flags & WE_HAVE_A_SCALE ) {
  				part.m.a = part.m.d = bin.readF2dot14(data, offset);  offset += 2;    
  			} else if ( flags & WE_HAVE_AN_X_AND_Y_SCALE ) {
  				part.m.a = bin.readF2dot14(data, offset);  offset += 2; 
  				part.m.d = bin.readF2dot14(data, offset);  offset += 2; 
  			} else if ( flags & WE_HAVE_A_TWO_BY_TWO ) {
  				part.m.a = bin.readF2dot14(data, offset);  offset += 2; 
  				part.m.b = bin.readF2dot14(data, offset);  offset += 2; 
  				part.m.c = bin.readF2dot14(data, offset);  offset += 2; 
  				part.m.d = bin.readF2dot14(data, offset);  offset += 2; 
  			}
  		} while ( flags & MORE_COMPONENTS ) 
  		if (flags & WE_HAVE_INSTRUCTIONS){
  			var numInstr = bin.readUshort(data, offset);  offset += 2;
  			gl.instr = [];
  			for(var i=0; i<numInstr; i++) { gl.instr.push(data[offset]);  offset++; }
  		}
  	}
  	return gl;
  };


  Typr.GPOS = {};
  Typr.GPOS.parse = function(data, offset, length, font) {  return Typr._lctf.parse(data, offset, length, font, Typr.GPOS.subt);  };


  Typr.GPOS.subt = function(data, ltype, offset)	// lookup type
  {
  	var bin = Typr._bin, offset0 = offset, tab = {};
  	
  	tab.fmt  = bin.readUshort(data, offset);  offset+=2;
  	
  	//console.log(ltype, tab.fmt);
  	
  	if(ltype==1 || ltype==2 || ltype==3 || ltype==7 || (ltype==8 && tab.fmt<=2)) {
  		var covOff  = bin.readUshort(data, offset);  offset+=2;
  		tab.coverage = Typr._lctf.readCoverage(data, covOff+offset0);
  	}
  	if(ltype==1 && tab.fmt==1) {
  		var valFmt1 = bin.readUshort(data, offset);  offset+=2;
  		var ones1 = Typr._lctf.numOfOnes(valFmt1);
  		if(valFmt1!=0)  { tab.pos = Typr.GPOS.readValueRecord(data, offset, valFmt1); }
  	}
  	else if(ltype==2) {
  		var valFmt1 = bin.readUshort(data, offset);  offset+=2;
  		var valFmt2 = bin.readUshort(data, offset);  offset+=2;
  		var ones1 = Typr._lctf.numOfOnes(valFmt1);
  		var ones2 = Typr._lctf.numOfOnes(valFmt2);
  		if(tab.fmt==1)
  		{
  			tab.pairsets = [];
  			var psc = bin.readUshort(data, offset);  offset+=2;  // PairSetCount
  			
  			for(var i=0; i<psc; i++)
  			{
  				var psoff = offset0 + bin.readUshort(data, offset);  offset+=2;
  				
  				var pvc = bin.readUshort(data, psoff);  psoff+=2;
  				var arr = [];
  				for(var j=0; j<pvc; j++)
  				{
  					var gid2 = bin.readUshort(data, psoff);  psoff+=2;
  					var value1, value2;
  					if(valFmt1!=0) {  value1 = Typr.GPOS.readValueRecord(data, psoff, valFmt1);  psoff+=ones1*2;  }
  					if(valFmt2!=0) {  value2 = Typr.GPOS.readValueRecord(data, psoff, valFmt2);  psoff+=ones2*2;  }
  					//if(value1!=null) throw "e";
  					arr.push({gid2:gid2, val1:value1, val2:value2});
  				}
  				tab.pairsets.push(arr);
  			}
  		}
  		if(tab.fmt==2)
  		{
  			var classDef1 = bin.readUshort(data, offset);  offset+=2;
  			var classDef2 = bin.readUshort(data, offset);  offset+=2;
  			var class1Count = bin.readUshort(data, offset);  offset+=2;
  			var class2Count = bin.readUshort(data, offset);  offset+=2;
  			
  			tab.classDef1 = Typr._lctf.readClassDef(data, offset0 + classDef1);
  			tab.classDef2 = Typr._lctf.readClassDef(data, offset0 + classDef2);
  			
  			tab.matrix = [];
  			for(var i=0; i<class1Count; i++)
  			{
  				var row = [];
  				for(var j=0; j<class2Count; j++)
  				{
  					var value1 = null, value2 = null;
  					if(tab.valFmt1!=0) { value1 = Typr.GPOS.readValueRecord(data, offset, tab.valFmt1);  offset+=ones1*2; }
  					if(tab.valFmt2!=0) { value2 = Typr.GPOS.readValueRecord(data, offset, tab.valFmt2);  offset+=ones2*2; }
  					row.push({val1:value1, val2:value2});
  				}
  				tab.matrix.push(row);
  			}
  		}
  	}
  	return tab;
  };


  Typr.GPOS.readValueRecord = function(data, offset, valFmt)
  {
  	var bin = Typr._bin;
  	var arr = [];
  	arr.push( (valFmt&1) ? bin.readShort(data, offset) : 0 );  offset += (valFmt&1) ? 2 : 0;  // X_PLACEMENT
  	arr.push( (valFmt&2) ? bin.readShort(data, offset) : 0 );  offset += (valFmt&2) ? 2 : 0;  // Y_PLACEMENT
  	arr.push( (valFmt&4) ? bin.readShort(data, offset) : 0 );  offset += (valFmt&4) ? 2 : 0;  // X_ADVANCE
  	arr.push( (valFmt&8) ? bin.readShort(data, offset) : 0 );  offset += (valFmt&8) ? 2 : 0;  // Y_ADVANCE
  	return arr;
  };

  Typr.GSUB = {};
  Typr.GSUB.parse = function(data, offset, length, font) {  return Typr._lctf.parse(data, offset, length, font, Typr.GSUB.subt);  };


  Typr.GSUB.subt = function(data, ltype, offset)	// lookup type
  {
  	var bin = Typr._bin, offset0 = offset, tab = {};
  	
  	tab.fmt  = bin.readUshort(data, offset);  offset+=2;
  	
  	if(ltype!=1 && ltype!=4 && ltype!=5 && ltype!=6) { return null; }
  	
  	if(ltype==1 || ltype==4 || (ltype==5 && tab.fmt<=2) || (ltype==6 && tab.fmt<=2)) {
  		var covOff  = bin.readUshort(data, offset);  offset+=2;
  		tab.coverage = Typr._lctf.readCoverage(data, offset0+covOff);	// not always is coverage here
  	}
  	
  	if(ltype==1) {	
  		if(tab.fmt==1) {
  			tab.delta = bin.readShort(data, offset);  offset+=2;
  		}
  		else if(tab.fmt==2) {
  			var cnt = bin.readUshort(data, offset);  offset+=2;
  			tab.newg = bin.readUshorts(data, offset, cnt);  offset+=tab.newg.length*2;
  		}
  	}
  	//  Ligature Substitution Subtable
  	else if(ltype==4) {
  		tab.vals = [];
  		var cnt = bin.readUshort(data, offset);  offset+=2;
  		for(var i=0; i<cnt; i++) {
  			var loff = bin.readUshort(data, offset);  offset+=2;
  			tab.vals.push(Typr.GSUB.readLigatureSet(data, offset0+loff));
  		}
  		//console.log(tab.coverage);
  		//console.log(tab.vals);
  	} 
  	//  Contextual Substitution Subtable
  	else if(ltype==5) {
  		if(tab.fmt==2) {
  			var cDefOffset = bin.readUshort(data, offset);  offset+=2;
  			tab.cDef = Typr._lctf.readClassDef(data, offset0 + cDefOffset);
  			tab.scset = [];
  			var subClassSetCount = bin.readUshort(data, offset);  offset+=2;
  			for(var i=0; i<subClassSetCount; i++)
  			{
  				var scsOff = bin.readUshort(data, offset);  offset+=2;
  				tab.scset.push(  scsOff==0 ? null : Typr.GSUB.readSubClassSet(data, offset0 + scsOff)  );
  			}
  		}
  		//else console.log("unknown table format", tab.fmt);
  	}
  	//*
  	else if(ltype==6) {
  		/*
  		if(tab.fmt==2) {
  			var btDef = bin.readUshort(data, offset);  offset+=2;
  			var inDef = bin.readUshort(data, offset);  offset+=2;
  			var laDef = bin.readUshort(data, offset);  offset+=2;
  			
  			tab.btDef = Typr._lctf.readClassDef(data, offset0 + btDef);
  			tab.inDef = Typr._lctf.readClassDef(data, offset0 + inDef);
  			tab.laDef = Typr._lctf.readClassDef(data, offset0 + laDef);
  			
  			tab.scset = [];
  			var cnt = bin.readUshort(data, offset);  offset+=2;
  			for(var i=0; i<cnt; i++) {
  				var loff = bin.readUshort(data, offset);  offset+=2;
  				tab.scset.push(Typr.GSUB.readChainSubClassSet(data, offset0+loff));
  			}
  		}
  		*/
  		if(tab.fmt==3) {
  			for(var i=0; i<3; i++) {
  				var cnt = bin.readUshort(data, offset);  offset+=2;
  				var cvgs = [];
  				for(var j=0; j<cnt; j++) { cvgs.push(  Typr._lctf.readCoverage(data, offset0 + bin.readUshort(data, offset+j*2))   ); }
  				offset+=cnt*2;
  				if(i==0) { tab.backCvg = cvgs; }
  				if(i==1) { tab.inptCvg = cvgs; }
  				if(i==2) { tab.ahedCvg = cvgs; }
  			}
  			var cnt = bin.readUshort(data, offset);  offset+=2;
  			tab.lookupRec = Typr.GSUB.readSubstLookupRecords(data, offset, cnt);
  		}
  		//console.log(tab);
  	} //*/
  	//if(tab.coverage.indexOf(3)!=-1) console.log(ltype, fmt, tab);
  	
  	return tab;
  };

  Typr.GSUB.readSubClassSet = function(data, offset)
  {
  	var rUs = Typr._bin.readUshort, offset0 = offset, lset = [];
  	var cnt = rUs(data, offset);  offset+=2;
  	for(var i=0; i<cnt; i++) {
  		var loff = rUs(data, offset);  offset+=2;
  		lset.push(Typr.GSUB.readSubClassRule(data, offset0+loff));
  	}
  	return lset;
  };
  Typr.GSUB.readSubClassRule= function(data, offset)
  {
  	var rUs = Typr._bin.readUshort, rule = {};
  	var gcount = rUs(data, offset);  offset+=2;
  	var scount = rUs(data, offset);  offset+=2;
  	rule.input = [];
  	for(var i=0; i<gcount-1; i++) {
  		rule.input.push(rUs(data, offset));  offset+=2;
  	}
  	rule.substLookupRecords = Typr.GSUB.readSubstLookupRecords(data, offset, scount);
  	return rule;
  };
  Typr.GSUB.readSubstLookupRecords = function(data, offset, cnt)
  {
  	var rUs = Typr._bin.readUshort;
  	var out = [];
  	for(var i=0; i<cnt; i++) {  out.push(rUs(data, offset), rUs(data, offset+2));  offset+=4;  }
  	return out;
  };

  Typr.GSUB.readChainSubClassSet = function(data, offset)
  {
  	var bin = Typr._bin, offset0 = offset, lset = [];
  	var cnt = bin.readUshort(data, offset);  offset+=2;
  	for(var i=0; i<cnt; i++) {
  		var loff = bin.readUshort(data, offset);  offset+=2;
  		lset.push(Typr.GSUB.readChainSubClassRule(data, offset0+loff));
  	}
  	return lset;
  };
  Typr.GSUB.readChainSubClassRule= function(data, offset)
  {
  	var bin = Typr._bin, rule = {};
  	var pps = ["backtrack", "input", "lookahead"];
  	for(var pi=0; pi<pps.length; pi++) {
  		var cnt = bin.readUshort(data, offset);  offset+=2;  if(pi==1) { cnt--; }
  		rule[pps[pi]]=bin.readUshorts(data, offset, cnt);  offset+= rule[pps[pi]].length*2;
  	}
  	var cnt = bin.readUshort(data, offset);  offset+=2;
  	rule.subst = bin.readUshorts(data, offset, cnt*2);  offset += rule.subst.length*2;
  	return rule;
  };

  Typr.GSUB.readLigatureSet = function(data, offset)
  {
  	var bin = Typr._bin, offset0 = offset, lset = [];
  	var lcnt = bin.readUshort(data, offset);  offset+=2;
  	for(var j=0; j<lcnt; j++) {
  		var loff = bin.readUshort(data, offset);  offset+=2;
  		lset.push(Typr.GSUB.readLigature(data, offset0+loff));
  	}
  	return lset;
  };
  Typr.GSUB.readLigature = function(data, offset)
  {
  	var bin = Typr._bin, lig = {chain:[]};
  	lig.nglyph = bin.readUshort(data, offset);  offset+=2;
  	var ccnt = bin.readUshort(data, offset);  offset+=2;
  	for(var k=0; k<ccnt-1; k++) {  lig.chain.push(bin.readUshort(data, offset));  offset+=2;  }
  	return lig;
  };



  Typr.head = {};
  Typr.head.parse = function(data, offset, length)
  {
  	var bin = Typr._bin;
  	var obj = {};
  	var tableVersion = bin.readFixed(data, offset);  offset += 4;
  	obj.fontRevision = bin.readFixed(data, offset);  offset += 4;
  	var checkSumAdjustment = bin.readUint(data, offset);  offset += 4;
  	var magicNumber = bin.readUint(data, offset);  offset += 4;
  	obj.flags = bin.readUshort(data, offset);  offset += 2;
  	obj.unitsPerEm = bin.readUshort(data, offset);  offset += 2;
  	obj.created  = bin.readUint64(data, offset);  offset += 8;
  	obj.modified = bin.readUint64(data, offset);  offset += 8;
  	obj.xMin = bin.readShort(data, offset);  offset += 2;
  	obj.yMin = bin.readShort(data, offset);  offset += 2;
  	obj.xMax = bin.readShort(data, offset);  offset += 2;
  	obj.yMax = bin.readShort(data, offset);  offset += 2;
  	obj.macStyle = bin.readUshort(data, offset);  offset += 2;
  	obj.lowestRecPPEM = bin.readUshort(data, offset);  offset += 2;
  	obj.fontDirectionHint = bin.readShort(data, offset);  offset += 2;
  	obj.indexToLocFormat  = bin.readShort(data, offset);  offset += 2;
  	obj.glyphDataFormat   = bin.readShort(data, offset);  offset += 2;
  	return obj;
  };


  Typr.hhea = {};
  Typr.hhea.parse = function(data, offset, length)
  {
  	var bin = Typr._bin;
  	var obj = {};
  	var tableVersion = bin.readFixed(data, offset);  offset += 4;
  	obj.ascender  = bin.readShort(data, offset);  offset += 2;
  	obj.descender = bin.readShort(data, offset);  offset += 2;
  	obj.lineGap = bin.readShort(data, offset);  offset += 2;
  	
  	obj.advanceWidthMax = bin.readUshort(data, offset);  offset += 2;
  	obj.minLeftSideBearing  = bin.readShort(data, offset);  offset += 2;
  	obj.minRightSideBearing = bin.readShort(data, offset);  offset += 2;
  	obj.xMaxExtent = bin.readShort(data, offset);  offset += 2;
  	
  	obj.caretSlopeRise = bin.readShort(data, offset);  offset += 2;
  	obj.caretSlopeRun  = bin.readShort(data, offset);  offset += 2;
  	obj.caretOffset    = bin.readShort(data, offset);  offset += 2;
  	
  	offset += 4*2;
  	
  	obj.metricDataFormat = bin.readShort (data, offset);  offset += 2;
  	obj.numberOfHMetrics = bin.readUshort(data, offset);  offset += 2;
  	return obj;
  };


  Typr.hmtx = {};
  Typr.hmtx.parse = function(data, offset, length, font)
  {
  	var bin = Typr._bin;
  	var obj = {};
  	
  	obj.aWidth = [];
  	obj.lsBearing = [];
  	
  	
  	var aw = 0, lsb = 0;
  	
  	for(var i=0; i<font.maxp.numGlyphs; i++)
  	{
  		if(i<font.hhea.numberOfHMetrics) {  aw=bin.readUshort(data, offset);  offset += 2;  lsb=bin.readShort(data, offset);  offset+=2;  }
  		obj.aWidth.push(aw);
  		obj.lsBearing.push(lsb);
  	}
  	
  	return obj;
  };


  Typr.kern = {};
  Typr.kern.parse = function(data, offset, length, font)
  {
  	var bin = Typr._bin;
  	
  	var version = bin.readUshort(data, offset);  offset+=2;
  	if(version==1) { return Typr.kern.parseV1(data, offset-2, length, font); }
  	var nTables = bin.readUshort(data, offset);  offset+=2;
  	
  	var map = {glyph1: [], rval:[]};
  	for(var i=0; i<nTables; i++)
  	{
  		offset+=2;	// skip version
  		var length  = bin.readUshort(data, offset);  offset+=2;
  		var coverage = bin.readUshort(data, offset);  offset+=2;
  		var format = coverage>>>8;
  		/* I have seen format 128 once, that's why I do */ format &= 0xf;
  		if(format==0) { offset = Typr.kern.readFormat0(data, offset, map); }
  		else { throw "unknown kern table format: "+format; }
  	}
  	return map;
  };

  Typr.kern.parseV1 = function(data, offset, length, font)
  {
  	var bin = Typr._bin;
  	
  	var version = bin.readFixed(data, offset);  offset+=4;
  	var nTables = bin.readUint(data, offset);  offset+=4;
  	
  	var map = {glyph1: [], rval:[]};
  	for(var i=0; i<nTables; i++)
  	{
  		var length = bin.readUint(data, offset);   offset+=4;
  		var coverage = bin.readUshort(data, offset);  offset+=2;
  		var tupleIndex = bin.readUshort(data, offset);  offset+=2;
  		var format = coverage>>>8;
  		/* I have seen format 128 once, that's why I do */ format &= 0xf;
  		if(format==0) { offset = Typr.kern.readFormat0(data, offset, map); }
  		else { throw "unknown kern table format: "+format; }
  	}
  	return map;
  };

  Typr.kern.readFormat0 = function(data, offset, map)
  {
  	var bin = Typr._bin;
  	var pleft = -1;
  	var nPairs        = bin.readUshort(data, offset);  offset+=2;
  	var searchRange   = bin.readUshort(data, offset);  offset+=2;
  	var entrySelector = bin.readUshort(data, offset);  offset+=2;
  	var rangeShift    = bin.readUshort(data, offset);  offset+=2;
  	for(var j=0; j<nPairs; j++)
  	{
  		var left  = bin.readUshort(data, offset);  offset+=2;
  		var right = bin.readUshort(data, offset);  offset+=2;
  		var value = bin.readShort (data, offset);  offset+=2;
  		if(left!=pleft) { map.glyph1.push(left);  map.rval.push({ glyph2:[], vals:[] }); }
  		var rval = map.rval[map.rval.length-1];
  		rval.glyph2.push(right);   rval.vals.push(value);
  		pleft = left;
  	}
  	return offset;
  };



  Typr.loca = {};
  Typr.loca.parse = function(data, offset, length, font)
  {
  	var bin = Typr._bin;
  	var obj = [];
  	
  	var ver = font.head.indexToLocFormat;
  	//console.log("loca", ver, length, 4*font.maxp.numGlyphs);
  	var len = font.maxp.numGlyphs+1;
  	
  	if(ver==0) { for(var i=0; i<len; i++) { obj.push(bin.readUshort(data, offset+(i<<1))<<1); } }
  	if(ver==1) { for(var i=0; i<len; i++) { obj.push(bin.readUint  (data, offset+(i<<2))   ); } }
  	
  	return obj;
  };


  Typr.maxp = {};
  Typr.maxp.parse = function(data, offset, length)
  {
  	//console.log(data.length, offset, length);
  	
  	var bin = Typr._bin;
  	var obj = {};
  	
  	// both versions 0.5 and 1.0
  	var ver = bin.readUint(data, offset); offset += 4;
  	obj.numGlyphs = bin.readUshort(data, offset);  offset += 2;
  	
  	// only 1.0
  	if(ver == 0x00010000)
  	{
  		obj.maxPoints             = bin.readUshort(data, offset);  offset += 2;
  		obj.maxContours           = bin.readUshort(data, offset);  offset += 2;
  		obj.maxCompositePoints    = bin.readUshort(data, offset);  offset += 2;
  		obj.maxCompositeContours  = bin.readUshort(data, offset);  offset += 2;
  		obj.maxZones              = bin.readUshort(data, offset);  offset += 2;
  		obj.maxTwilightPoints     = bin.readUshort(data, offset);  offset += 2;
  		obj.maxStorage            = bin.readUshort(data, offset);  offset += 2;
  		obj.maxFunctionDefs       = bin.readUshort(data, offset);  offset += 2;
  		obj.maxInstructionDefs    = bin.readUshort(data, offset);  offset += 2;
  		obj.maxStackElements      = bin.readUshort(data, offset);  offset += 2;
  		obj.maxSizeOfInstructions = bin.readUshort(data, offset);  offset += 2;
  		obj.maxComponentElements  = bin.readUshort(data, offset);  offset += 2;
  		obj.maxComponentDepth     = bin.readUshort(data, offset);  offset += 2;
  	}
  	
  	return obj;
  };


  Typr.name = {};
  Typr.name.parse = function(data, offset, length)
  {
  	var bin = Typr._bin;
  	var obj = {};
  	var format = bin.readUshort(data, offset);  offset += 2;
  	var count  = bin.readUshort(data, offset);  offset += 2;
  	var stringOffset = bin.readUshort(data, offset);  offset += 2;
  	
  	//console.log(format,count);
  	
  	var names = [
  		"copyright",
  		"fontFamily",
  		"fontSubfamily",
  		"ID",
  		"fullName",
  		"version",
  		"postScriptName",
  		"trademark",
  		"manufacturer",
  		"designer",
  		"description",
  		"urlVendor",
  		"urlDesigner",
  		"licence",
  		"licenceURL",
  		"---",
  		"typoFamilyName",
  		"typoSubfamilyName",
  		"compatibleFull",
  		"sampleText",
  		"postScriptCID",
  		"wwsFamilyName",
  		"wwsSubfamilyName",
  		"lightPalette",
  		"darkPalette"
  	];
  	
  	var offset0 = offset;
  	
  	for(var i=0; i<count; i++)
  	{
  		var platformID = bin.readUshort(data, offset);  offset += 2;
  		var encodingID = bin.readUshort(data, offset);  offset += 2;
  		var languageID = bin.readUshort(data, offset);  offset += 2;
  		var nameID     = bin.readUshort(data, offset);  offset += 2;
  		var slen       = bin.readUshort(data, offset);  offset += 2;
  		var noffset    = bin.readUshort(data, offset);  offset += 2;
  		//console.log(platformID, encodingID, languageID.toString(16), nameID, length, noffset);
  		
  		var cname = names[nameID];
  		var soff = offset0 + count*12 + noffset;
  		var str;
  		if(platformID == 0) { str = bin.readUnicode(data, soff, slen/2); }
  		else if(platformID == 3 && encodingID == 0) { str = bin.readUnicode(data, soff, slen/2); }
  		else if(encodingID == 0) { str = bin.readASCII  (data, soff, slen); }
  		else if(encodingID == 1) { str = bin.readUnicode(data, soff, slen/2); }
  		else if(encodingID == 3) { str = bin.readUnicode(data, soff, slen/2); }
  		
  		else if(platformID == 1) { str = bin.readASCII(data, soff, slen);  console.log("reading unknown MAC encoding "+encodingID+" as ASCII"); }
  		else { throw "unknown encoding "+encodingID + ", platformID: "+platformID; }
  		
  		var tid = "p"+platformID+","+(languageID).toString(16);//Typr._platforms[platformID];
  		if(obj[tid]==null) { obj[tid] = {}; }
  		obj[tid][cname] = str;
  		obj[tid]._lang = languageID;
  		//console.log(tid, obj[tid]);
  	}
  	/*
  	if(format == 1)
  	{
  		var langTagCount = bin.readUshort(data, offset);  offset += 2;
  		for(var i=0; i<langTagCount; i++)
  		{
  			var length  = bin.readUshort(data, offset);  offset += 2;
  			var noffset = bin.readUshort(data, offset);  offset += 2;
  		}
  	}
  	*/
  	
  	//console.log(obj);
  	
  	for(var p in obj) { if(obj[p].postScriptName!=null && obj[p]._lang==0x0409) { return obj[p]; } }		// United States
  	for(var p in obj) { if(obj[p].postScriptName!=null && obj[p]._lang==0x0000) { return obj[p]; } }		// Universal
  	for(var p in obj) { if(obj[p].postScriptName!=null && obj[p]._lang==0x0c0c) { return obj[p]; } }		// Canada
  	for(var p in obj) { if(obj[p].postScriptName!=null) { return obj[p]; } }
  	
  	var tname;
  	for(var p in obj) { tname=p; break; }
  	console.log("returning name table with languageID "+ obj[tname]._lang);
  	return obj[tname];
  };


  Typr["OS/2"] = {};
  Typr["OS/2"].parse = function(data, offset, length)
  {
  	var bin = Typr._bin;
  	var ver = bin.readUshort(data, offset); offset += 2;
  	
  	var obj = {};
  	if     (ver==0) { Typr["OS/2"].version0(data, offset, obj); }
  	else if(ver==1) { Typr["OS/2"].version1(data, offset, obj); }
  	else if(ver==2 || ver==3 || ver==4) { Typr["OS/2"].version2(data, offset, obj); }
  	else if(ver==5) { Typr["OS/2"].version5(data, offset, obj); }
  	else { throw "unknown OS/2 table version: "+ver; }
  	
  	return obj;
  };

  Typr["OS/2"].version0 = function(data, offset, obj)
  {
  	var bin = Typr._bin;
  	obj.xAvgCharWidth = bin.readShort(data, offset); offset += 2;
  	obj.usWeightClass = bin.readUshort(data, offset); offset += 2;
  	obj.usWidthClass  = bin.readUshort(data, offset); offset += 2;
  	obj.fsType = bin.readUshort(data, offset); offset += 2;
  	obj.ySubscriptXSize = bin.readShort(data, offset); offset += 2;
  	obj.ySubscriptYSize = bin.readShort(data, offset); offset += 2;
  	obj.ySubscriptXOffset = bin.readShort(data, offset); offset += 2;
  	obj.ySubscriptYOffset = bin.readShort(data, offset); offset += 2; 
  	obj.ySuperscriptXSize = bin.readShort(data, offset); offset += 2; 
  	obj.ySuperscriptYSize = bin.readShort(data, offset); offset += 2; 
  	obj.ySuperscriptXOffset = bin.readShort(data, offset); offset += 2;
  	obj.ySuperscriptYOffset = bin.readShort(data, offset); offset += 2;
  	obj.yStrikeoutSize = bin.readShort(data, offset); offset += 2;
  	obj.yStrikeoutPosition = bin.readShort(data, offset); offset += 2;
  	obj.sFamilyClass = bin.readShort(data, offset); offset += 2;
  	obj.panose = bin.readBytes(data, offset, 10);  offset += 10;
  	obj.ulUnicodeRange1	= bin.readUint(data, offset);  offset += 4;
  	obj.ulUnicodeRange2	= bin.readUint(data, offset);  offset += 4;
  	obj.ulUnicodeRange3	= bin.readUint(data, offset);  offset += 4;
  	obj.ulUnicodeRange4	= bin.readUint(data, offset);  offset += 4;
  	obj.achVendID = [bin.readInt8(data, offset), bin.readInt8(data, offset+1),bin.readInt8(data, offset+2),bin.readInt8(data, offset+3)];  offset += 4;
  	obj.fsSelection	 = bin.readUshort(data, offset); offset += 2;
  	obj.usFirstCharIndex = bin.readUshort(data, offset); offset += 2;
  	obj.usLastCharIndex = bin.readUshort(data, offset); offset += 2;
  	obj.sTypoAscender = bin.readShort(data, offset); offset += 2;
  	obj.sTypoDescender = bin.readShort(data, offset); offset += 2;
  	obj.sTypoLineGap = bin.readShort(data, offset); offset += 2;
  	obj.usWinAscent = bin.readUshort(data, offset); offset += 2;
  	obj.usWinDescent = bin.readUshort(data, offset); offset += 2;
  	return offset;
  };

  Typr["OS/2"].version1 = function(data, offset, obj)
  {
  	var bin = Typr._bin;
  	offset = Typr["OS/2"].version0(data, offset, obj);
  	
  	obj.ulCodePageRange1 = bin.readUint(data, offset); offset += 4;
  	obj.ulCodePageRange2 = bin.readUint(data, offset); offset += 4;
  	return offset;
  };

  Typr["OS/2"].version2 = function(data, offset, obj)
  {
  	var bin = Typr._bin;
  	offset = Typr["OS/2"].version1(data, offset, obj);
  	
  	obj.sxHeight = bin.readShort(data, offset); offset += 2;
  	obj.sCapHeight = bin.readShort(data, offset); offset += 2;
  	obj.usDefault = bin.readUshort(data, offset); offset += 2;
  	obj.usBreak = bin.readUshort(data, offset); offset += 2;
  	obj.usMaxContext = bin.readUshort(data, offset); offset += 2;
  	return offset;
  };

  Typr["OS/2"].version5 = function(data, offset, obj)
  {
  	var bin = Typr._bin;
  	offset = Typr["OS/2"].version2(data, offset, obj);

  	obj.usLowerOpticalPointSize = bin.readUshort(data, offset); offset += 2;
  	obj.usUpperOpticalPointSize = bin.readUshort(data, offset); offset += 2;
  	return offset;
  };

  Typr.post = {};
  Typr.post.parse = function(data, offset, length)
  {
  	var bin = Typr._bin;
  	var obj = {};
  	
  	obj.version           = bin.readFixed(data, offset);  offset+=4;
  	obj.italicAngle       = bin.readFixed(data, offset);  offset+=4;
  	obj.underlinePosition = bin.readShort(data, offset);  offset+=2;
  	obj.underlineThickness = bin.readShort(data, offset);  offset+=2;

  	return obj;
  };
  Typr.SVG = {};
  Typr.SVG.parse = function(data, offset, length)
  {
  	var bin = Typr._bin;
  	var obj = { entries: []};

  	var offset0 = offset;

  	var tableVersion = bin.readUshort(data, offset);	offset += 2;
  	var svgDocIndexOffset = bin.readUint(data, offset);	offset += 4;
  	var reserved = bin.readUint(data, offset); offset += 4;

  	offset = svgDocIndexOffset + offset0;

  	var numEntries = bin.readUshort(data, offset);	offset += 2;

  	for(var i=0; i<numEntries; i++)
  	{
  		var startGlyphID = bin.readUshort(data, offset);  offset += 2;
  		var endGlyphID   = bin.readUshort(data, offset);  offset += 2;
  		var svgDocOffset = bin.readUint  (data, offset);  offset += 4;
  		var svgDocLength = bin.readUint  (data, offset);  offset += 4;

  		var sbuf = new Uint8Array(data.buffer, offset0 + svgDocOffset + svgDocIndexOffset, svgDocLength);
  		var svg = bin.readUTF8(sbuf, 0, sbuf.length);
  		
  		for(var f=startGlyphID; f<=endGlyphID; f++) {
  			obj.entries[f] = svg;
  		}
  	}
  	return obj;
  };

  Typr.SVG.toPath = function(str)
  {
  	var pth = {cmds:[], crds:[]};
  	if(str==null) { return pth; }
  	
  	var prsr = new DOMParser();
  	var doc = prsr["parseFromString"](str,"image/svg+xml");
  	
  	var svg = doc.firstChild;  while(svg.tagName!="svg") { svg = svg.nextSibling; }
  	var vb = svg.getAttribute("viewBox");
  	if(vb) { vb = vb.trim().split(" ").map(parseFloat); }  else   { vb = [0,0,1000,1000]; }
  	Typr.SVG._toPath(svg.children, pth);
  	for(var i=0; i<pth.crds.length; i+=2) {
  		var x = pth.crds[i], y = pth.crds[i+1];
  		x -= vb[0];
  		y -= vb[1];
  		y = -y;
  		pth.crds[i] = x;
  		pth.crds[i+1] = y;
  	}
  	return pth;
  };

  Typr.SVG._toPath = function(nds, pth, fill) {
  	for(var ni=0; ni<nds.length; ni++) {
  		var nd = nds[ni], tn = nd.tagName;
  		var cfl = nd.getAttribute("fill");  if(cfl==null) { cfl = fill; }
  		if(tn=="g") { Typr.SVG._toPath(nd.children, pth, cfl); }
  		else if(tn=="path") {
  			pth.cmds.push(cfl?cfl:"#000000");
  			var d = nd.getAttribute("d");  //console.log(d);
  			var toks = Typr.SVG._tokens(d);  //console.log(toks);
  			Typr.SVG._toksToPath(toks, pth);  pth.cmds.push("X");
  		}
  		else if(tn=="defs") ;
  		else { console.log(tn, nd); }
  	}
  };

  Typr.SVG._tokens = function(d) {
  	var ts = [], off = 0, rn=false, cn="";  // reading number, current number
  	while(off<d.length){
  		var cc=d.charCodeAt(off), ch = d.charAt(off);  off++;
  		var isNum = (48<=cc && cc<=57) || ch=="." || ch=="-";
  		
  		if(rn) {
  			if(ch=="-") {  ts.push(parseFloat(cn));  cn=ch;  }
  			else if(isNum) { cn+=ch; }
  			else {  ts.push(parseFloat(cn));  if(ch!="," && ch!=" ") { ts.push(ch); }  rn=false;  }
  		}
  		else {
  			if(isNum) {  cn=ch;  rn=true;  }
  			else if(ch!="," && ch!=" ") { ts.push(ch); }
  		}
  	}
  	if(rn) { ts.push(parseFloat(cn)); }
  	return ts;
  };

  Typr.SVG._toksToPath = function(ts, pth) {	
  	var i = 0, x = 0, y = 0, ox = 0, oy = 0;
  	var pc = {"M":2,"L":2,"H":1,"V":1,   "S":4,   "C":6};
  	var cmds = pth.cmds, crds = pth.crds;
  	
  	while(i<ts.length) {
  		var cmd = ts[i];  i++;
  		
  		if(cmd=="z") {  cmds.push("Z");  x=ox;  y=oy;  }
  		else {
  			var cmu = cmd.toUpperCase();
  			var ps = pc[cmu], reps = Typr.SVG._reps(ts, i, ps);
  		
  			for(var j=0; j<reps; j++) {
  				var xi = 0, yi = 0;   if(cmd!=cmu) {  xi=x;  yi=y;  }
  				
  				if(cmu=="M") {  x = xi+ts[i++];  y = yi+ts[i++];  cmds.push("M");  crds.push(x,y);  ox=x;  oy=y; }
  				else if(cmu=="L") {  x = xi+ts[i++];  y = yi+ts[i++];  cmds.push("L");  crds.push(x,y);  }
  				else if(cmu=="H") {  x = xi+ts[i++];                   cmds.push("L");  crds.push(x,y);  }
  				else if(cmu=="V") {  y = yi+ts[i++];                   cmds.push("L");  crds.push(x,y);  }
  				else if(cmu=="C") {
  					var x1=xi+ts[i++], y1=yi+ts[i++], x2=xi+ts[i++], y2=yi+ts[i++], x3=xi+ts[i++], y3=yi+ts[i++];
  					cmds.push("C");  crds.push(x1,y1,x2,y2,x3,y3);  x=x3;  y=y3;
  				}
  				else if(cmu=="S") {
  					var co = Math.max(crds.length-4, 0);
  					var x1 = x+x-crds[co], y1 = y+y-crds[co+1];
  					var x2=xi+ts[i++], y2=yi+ts[i++], x3=xi+ts[i++], y3=yi+ts[i++];  
  					cmds.push("C");  crds.push(x1,y1,x2,y2,x3,y3);  x=x3;  y=y3;
  				}
  				else { console.log("Unknown SVG command "+cmd); }
  			}
  		}
  	}
  };
  Typr.SVG._reps = function(ts, off, ps) {
  	var i = off;
  	while(i<ts.length) {  if((typeof ts[i]) == "string") { break; }  i+=ps;  }
  	return (i-off)/ps;
  };
  // End Typr.js

  // Begin Typr.U.js

  if(Typr  ==null) { Typr   = {}; }
  if(Typr.U==null) { Typr.U = {}; }


  Typr.U.codeToGlyph = function(font, code)
  {
  	var cmap = font.cmap;
  	
  	var tind = -1;
  	if(cmap.p0e4!=null) { tind = cmap.p0e4; }
  	else if(cmap.p3e1!=null) { tind = cmap.p3e1; }
  	else if(cmap.p1e0!=null) { tind = cmap.p1e0; }
  	else if(cmap.p0e3!=null) { tind = cmap.p0e3; }
  	
  	if(tind==-1) { throw "no familiar platform and encoding!"; }
  	
  	var tab = cmap.tables[tind];
  	
  	if(tab.format==0)
  	{
  		if(code>=tab.map.length) { return 0; }
  		return tab.map[code];
  	}
  	else if(tab.format==4)
  	{
  		var sind = -1;
  		for(var i=0; i<tab.endCount.length; i++)   { if(code<=tab.endCount[i]){  sind=i;  break;  } } 
  		if(sind==-1) { return 0; }
  		if(tab.startCount[sind]>code) { return 0; }
  		
  		var gli = 0;
  		if(tab.idRangeOffset[sind]!=0) { gli = tab.glyphIdArray[(code-tab.startCount[sind]) + (tab.idRangeOffset[sind]>>1) - (tab.idRangeOffset.length-sind)]; }
  		else                           { gli = code + tab.idDelta[sind]; }
  		return gli & 0xFFFF;
  	}
  	else if(tab.format==12)
  	{
  		if(code>tab.groups[tab.groups.length-1][1]) { return 0; }
  		for(var i=0; i<tab.groups.length; i++)
  		{
  			var grp = tab.groups[i];
  			if(grp[0]<=code && code<=grp[1]) { return grp[2] + (code-grp[0]); }
  		}
  		return 0;
  	}
  	else { throw "unknown cmap table format "+tab.format; }
  };


  Typr.U.glyphToPath = function(font, gid)
  {
  	var path = { cmds:[], crds:[] };
  	if(font.SVG && font.SVG.entries[gid]) {
  		var p = font.SVG.entries[gid];  if(p==null) { return path; }
  		if(typeof p == "string") {  p = Typr.SVG.toPath(p);  font.SVG.entries[gid]=p;  }
  		return p;
  	}
  	else if(font.CFF) {
  		var state = {x:0,y:0,stack:[],nStems:0,haveWidth:false,width: font.CFF.Private ? font.CFF.Private.defaultWidthX : 0,open:false};
  		var cff=font.CFF, pdct = font.CFF.Private;
  		if(cff.ROS) {
  			var gi = 0;
  			while(cff.FDSelect[gi+2]<=gid) { gi+=2; }
  			pdct = cff.FDArray[cff.FDSelect[gi+1]].Private;
  		}
  		Typr.U._drawCFF(font.CFF.CharStrings[gid], state, cff, pdct, path);
  	}
  	else if(font.glyf) {  Typr.U._drawGlyf(gid, font, path);  }
  	return path;
  };

  Typr.U._drawGlyf = function(gid, font, path)
  {
  	var gl = font.glyf[gid];
  	if(gl==null) { gl = font.glyf[gid] = Typr.glyf._parseGlyf(font, gid); }
  	if(gl!=null){
  		if(gl.noc>-1) { Typr.U._simpleGlyph(gl, path); }
  		else          { Typr.U._compoGlyph (gl, font, path); }
  	}
  };
  Typr.U._simpleGlyph = function(gl, p)
  {
  	for(var c=0; c<gl.noc; c++)
  	{
  		var i0 = (c==0) ? 0 : (gl.endPts[c-1] + 1);
  		var il = gl.endPts[c];
  		
  		for(var i=i0; i<=il; i++)
  		{
  			var pr = (i==i0)?il:(i-1);
  			var nx = (i==il)?i0:(i+1);
  			var onCurve = gl.flags[i]&1;
  			var prOnCurve = gl.flags[pr]&1;
  			var nxOnCurve = gl.flags[nx]&1;
  			
  			var x = gl.xs[i], y = gl.ys[i];
  			
  			if(i==i0) { 
  				if(onCurve)  
  				{
  					if(prOnCurve) { Typr.U.P.moveTo(p, gl.xs[pr], gl.ys[pr]); } 
  					else          {  Typr.U.P.moveTo(p,x,y);  continue;  /*  will do curveTo at il  */  }
  				}
  				else        
  				{
  					if(prOnCurve) { Typr.U.P.moveTo(p,  gl.xs[pr],       gl.ys[pr]        ); }
  					else          { Typr.U.P.moveTo(p, (gl.xs[pr]+x)/2, (gl.ys[pr]+y)/2   ); } 
  				}
  			}
  			if(onCurve)
  			{
  				if(prOnCurve) { Typr.U.P.lineTo(p,x,y); }
  			}
  			else
  			{
  				if(nxOnCurve) { Typr.U.P.qcurveTo(p, x, y, gl.xs[nx], gl.ys[nx]); } 
  				else          { Typr.U.P.qcurveTo(p, x, y, (x+gl.xs[nx])/2, (y+gl.ys[nx])/2); } 
  			}
  		}
  		Typr.U.P.closePath(p);
  	}
  };
  Typr.U._compoGlyph = function(gl, font, p)
  {
  	for(var j=0; j<gl.parts.length; j++)
  	{
  		var path = { cmds:[], crds:[] };
  		var prt = gl.parts[j];
  		Typr.U._drawGlyf(prt.glyphIndex, font, path);
  		
  		var m = prt.m;
  		for(var i=0; i<path.crds.length; i+=2)
  		{
  			var x = path.crds[i  ], y = path.crds[i+1];
  			p.crds.push(x*m.a + y*m.b + m.tx);
  			p.crds.push(x*m.c + y*m.d + m.ty);
  		}
  		for(var i=0; i<path.cmds.length; i++) { p.cmds.push(path.cmds[i]); }
  	}
  };


  Typr.U._getGlyphClass = function(g, cd)
  {
  	var intr = Typr._lctf.getInterval(cd, g);
  	return intr==-1 ? 0 : cd[intr+2];
  	//for(var i=0; i<cd.start.length; i++) 
  	//	if(cd.start[i]<=g && cd.end[i]>=g) return cd.class[i];
  	//return 0;
  };

  Typr.U.getPairAdjustment = function(font, g1, g2)
  {
  	//return 0;
  	if(font.GPOS) {
  		var gpos = font["GPOS"];
  		var llist = gpos.lookupList, flist = gpos.featureList;
  		var tused = [];
  		for(var i=0; i<flist.length; i++) 
  		{
  			var fl = flist[i];  //console.log(fl);
  			if(fl.tag!="kern") { continue; }
  			for(var ti=0; ti<fl.tab.length; ti++) {
  				if(tused[fl.tab[ti]]) { continue; }  tused[fl.tab[ti]] = true;
  				var tab = llist[fl.tab[ti]];
  				//console.log(tab);
  				
  				for(var j=0; j<tab.tabs.length; j++)
  				{
  					if(tab.tabs[i]==null) { continue; }
  					var ltab = tab.tabs[j], ind;
  					if(ltab.coverage) {  ind = Typr._lctf.coverageIndex(ltab.coverage, g1);  if(ind==-1) { continue; }  }
  					
  					if(tab.ltype==1) ;
  					else if(tab.ltype==2)
  					{
  						var adj;
  						if(ltab.fmt==1)
  						{
  							var right = ltab.pairsets[ind];
  							for(var i=0; i<right.length; i++) { if(right[i].gid2==g2) { adj = right[i]; } }
  						}
  						else if(ltab.fmt==2)
  						{
  							var c1 = Typr.U._getGlyphClass(g1, ltab.classDef1);
  							var c2 = Typr.U._getGlyphClass(g2, ltab.classDef2);
  							adj = ltab.matrix[c1][c2];
  						}
  						//if(adj) console.log(ltab, adj);
  						if(adj && adj.val2) { return adj.val2[2]; }
  					}
  				}
  			}
  		}
  	}
  	if(font.kern)
  	{
  		var ind1 = font.kern.glyph1.indexOf(g1);
  		if(ind1!=-1)
  		{
  			var ind2 = font.kern.rval[ind1].glyph2.indexOf(g2);
  			if(ind2!=-1) { return font.kern.rval[ind1].vals[ind2]; }
  		}
  	}
  	
  	return 0;
  };

  Typr.U.stringToGlyphs = function(font, str)
  {
  	var gls = [];
  	for(var i=0; i<str.length; i++) {
  		var cc = str.codePointAt(i);  if(cc>0xffff) { i++; }
  		gls.push(Typr.U.codeToGlyph(font, cc));
  	}
  	for(var i=0; i<str.length; i++) {
  		var cc = str.codePointAt(i);  //
  		if(cc==2367) {  var t=gls[i-1];  gls[i-1]=gls[i];  gls[i]=t;  }
  		//if(cc==2381) {  var t=gls[i+1];  gls[i+1]=gls[i];  gls[i]=t;  }
  		if(cc>0xffff) { i++; }
  	}
  	//console.log(gls.slice(0));
  	
  	//console.log(gls);  return gls;
  	
  	var gsub = font["GSUB"];  if(gsub==null) { return gls; }
  	var llist = gsub.lookupList, flist = gsub.featureList;
  	
  	var cligs = ["rlig", "liga", "mset",  "isol","init","fina","medi",   "half", "pres", 
  				"blws" /* Tibetan fonts like Himalaya.ttf */ ];
  	
  	//console.log(gls.slice(0));
  	var tused = [];
  	for(var fi=0; fi<flist.length; fi++)
  	{
  		var fl = flist[fi];  if(cligs.indexOf(fl.tag)==-1) { continue; }
  		//if(fl.tag=="blwf") continue;
  		//console.log(fl);
  		//console.log(fl.tag);
  		for(var ti=0; ti<fl.tab.length; ti++) {
  			if(tused[fl.tab[ti]]) { continue; }  tused[fl.tab[ti]] = true;
  			var tab = llist[fl.tab[ti]];
  			//console.log(fl.tab[ti], tab.ltype);
  			//console.log(fl.tag, tab);
  			for(var ci=0; ci<gls.length; ci++) {
  				var feat = Typr.U._getWPfeature(str, ci);
  				if("isol,init,fina,medi".indexOf(fl.tag)!=-1 && fl.tag!=feat) { continue; }
  				
  				Typr.U._applySubs(gls, ci, tab, llist);
  			}
  		}
  	}
  	
  	return gls;
  };
  Typr.U._getWPfeature = function(str, ci) {  // get Word Position feature
  	var wsep = "\n\t\" ,.:;!?()  ،";
  	var R = "آأؤإاةدذرزوٱٲٳٵٶٷڈډڊڋڌڍڎڏڐڑڒړڔڕږڗژڙۀۃۄۅۆۇۈۉۊۋۍۏےۓەۮۯܐܕܖܗܘܙܞܨܪܬܯݍݙݚݛݫݬݱݳݴݸݹࡀࡆࡇࡉࡔࡧࡩࡪࢪࢫࢬࢮࢱࢲࢹૅેૉ૊૎૏ૐ૑૒૝ૡ૤૯஁ஃ஄அஉ஌எஏ஑னப஫஬";
  	var L = "ꡲ્૗";
  	
  	var slft = ci==0            || wsep.indexOf(str[ci-1])!=-1;
  	var srgt = ci==str.length-1 || wsep.indexOf(str[ci+1])!=-1;
  		
  	if(!slft && R.indexOf(str[ci-1])!=-1) { slft=true; }
  	if(!srgt && R.indexOf(str[ci  ])!=-1) { srgt=true; }
  		
  	if(!srgt && L.indexOf(str[ci+1])!=-1) { srgt=true; }
  	if(!slft && L.indexOf(str[ci  ])!=-1) { slft=true; }
  		
  	var feat = null;
  	if(slft) { feat = srgt ? "isol" : "init"; }
  	else     { feat = srgt ? "fina" : "medi"; }
  	
  	return feat;
  };
  Typr.U._applySubs = function(gls, ci, tab, llist) {
  	var rlim = gls.length-ci-1;
  	//if(ci==0) console.log("++++ ", tab.ltype);
  	for(var j=0; j<tab.tabs.length; j++)
  	{
  		if(tab.tabs[j]==null) { continue; }
  		var ltab = tab.tabs[j], ind;
  		if(ltab.coverage) {  ind = Typr._lctf.coverageIndex(ltab.coverage, gls[ci]);  if(ind==-1) { continue; }  }
  		//if(ci==0) console.log(ind, ltab);
  		//*
  		if(tab.ltype==1) {
  			var gl = gls[ci];
  			if(ltab.fmt==1) { gls[ci] = gls[ci]+ltab.delta; }
  			else            { gls[ci] = ltab.newg[ind]; }
  			//console.log("applying ... 1", ci, gl, gls[ci]);
  		}//*
  		else if(tab.ltype==4) {
  			var vals = ltab.vals[ind];
  			
  			for(var k=0; k<vals.length; k++) {
  				var lig = vals[k], rl = lig.chain.length;  if(rl>rlim) { continue; }
  				var good = true, em1 = 0;
  				for(var l=0; l<rl; l++) {  while(gls[ci+em1+(1+l)]==-1){ em1++; }  if(lig.chain[l]!=gls[ci+em1+(1+l)]) { good=false; }  }
  				if(!good) { continue; }
  				gls[ci]=lig.nglyph;
  				for(var l=0; l<rl+em1; l++) { gls[ci+l+1]=-1; }   break;  // first character changed, other ligatures do not apply anymore
  				//console.log("lig", ci, lig.chain, lig.nglyph);
  				//console.log("applying ...");
  			}
  		}
  		else  if(tab.ltype==5 && ltab.fmt==2) {
  			var cind = Typr._lctf.getInterval(ltab.cDef, gls[ci]);
  			var cls = ltab.cDef[cind+2], scs = ltab.scset[cls]; 
  			for(var i=0; i<scs.length; i++) {
  				var sc = scs[i], inp = sc.input;
  				if(inp.length>rlim) { continue; }
  				var good = true;
  				for(var l=0; l<inp.length; l++) {
  					var cind2 = Typr._lctf.getInterval(ltab.cDef, gls[ci+1+l]);
  					if(cind==-1 && ltab.cDef[cind2+2]!=inp[l]) {  good=false;  break;  }
  				}
  				if(!good) { continue; }
  				//console.log(ci, gl);
  				var lrs = sc.substLookupRecords;
  				for(var k=0; k<lrs.length; k+=2)
  				{
  					var gi = lrs[k], tabi = lrs[k+1];
  					//Typr.U._applyType1(gls, ci+gi, llist[tabi]);
  					//console.log(tabi, gls[ci+gi], llist[tabi]);
  				}
  			}
  		}
  		else if(tab.ltype==6 && ltab.fmt==3) {
  			//if(ltab.backCvg.length==0) return;
  			if(!Typr.U._glsCovered(gls, ltab.backCvg, ci-ltab.backCvg.length)) { continue; }
  			if(!Typr.U._glsCovered(gls, ltab.inptCvg, ci)) { continue; }
  			if(!Typr.U._glsCovered(gls, ltab.ahedCvg, ci+ltab.inptCvg.length)) { continue; }
  			//console.log(ci, ltab);
  			var lr = ltab.lookupRec;  //console.log(ci, gl, lr);
  			for(var i=0; i<lr.length; i+=2) {
  				var cind = lr[i], tab2 = llist[lr[i+1]];
  				//console.log("-", lr[i+1], tab2);
  				Typr.U._applySubs(gls, ci+cind, tab2, llist);
  			}
  		}
  		//else console.log("Unknown table", tab.ltype, ltab.fmt);
  		//*/
  	}
  };

  Typr.U._glsCovered = function(gls, cvgs, ci) {
  	for(var i=0; i<cvgs.length; i++) {
  		var ind = Typr._lctf.coverageIndex(cvgs[i], gls[ci+i]);  if(ind==-1) { return false; }
  	}
  	return true;
  };

  Typr.U.glyphsToPath = function(font, gls, clr)
  {	
  	//gls = gls.reverse();//gls.slice(0,12).concat(gls.slice(12).reverse());
  	
  	var tpath = {cmds:[], crds:[]};
  	var x = 0;
  	
  	for(var i=0; i<gls.length; i++)
  	{
  		var gid = gls[i];  if(gid==-1) { continue; }
  		var gid2 = (i<gls.length-1 && gls[i+1]!=-1)  ? gls[i+1] : 0;
  		var path = Typr.U.glyphToPath(font, gid);
  		for(var j=0; j<path.crds.length; j+=2)
  		{
  			tpath.crds.push(path.crds[j] + x);
  			tpath.crds.push(path.crds[j+1]);
  		}
  		if(clr) { tpath.cmds.push(clr); }
  		for(var j=0; j<path.cmds.length; j++) { tpath.cmds.push(path.cmds[j]); }
  		if(clr) { tpath.cmds.push("X"); }
  		x += font.hmtx.aWidth[gid];// - font.hmtx.lsBearing[gid];
  		if(i<gls.length-1) { x += Typr.U.getPairAdjustment(font, gid, gid2); }
  	}
  	return tpath;
  };

  Typr.U.pathToSVG = function(path, prec)
  {
  	if(prec==null) { prec = 5; }
  	var out = [], co = 0, lmap = {"M":2,"L":2,"Q":4,"C":6};
  	for(var i=0; i<path.cmds.length; i++)
  	{
  		var cmd = path.cmds[i], cn = co+(lmap[cmd]?lmap[cmd]:0);  
  		out.push(cmd);
  		while(co<cn) {  var c = path.crds[co++];  out.push(parseFloat(c.toFixed(prec))+(co==cn?"":" "));  }
  	}
  	return out.join("");
  };

  Typr.U.pathToContext = function(path, ctx)
  {
  	var c = 0, crds = path.crds;
  	
  	for(var j=0; j<path.cmds.length; j++)
  	{
  		var cmd = path.cmds[j];
  		if     (cmd=="M") {
  			ctx.moveTo(crds[c], crds[c+1]);
  			c+=2;
  		}
  		else if(cmd=="L") {
  			ctx.lineTo(crds[c], crds[c+1]);
  			c+=2;
  		}
  		else if(cmd=="C") {
  			ctx.bezierCurveTo(crds[c], crds[c+1], crds[c+2], crds[c+3], crds[c+4], crds[c+5]);
  			c+=6;
  		}
  		else if(cmd=="Q") {
  			ctx.quadraticCurveTo(crds[c], crds[c+1], crds[c+2], crds[c+3]);
  			c+=4;
  		}
  		else if(cmd.charAt(0)=="#") {
  			ctx.beginPath();
  			ctx.fillStyle = cmd;
  		}
  		else if(cmd=="Z") {
  			ctx.closePath();
  		}
  		else if(cmd=="X") {
  			ctx.fill();
  		}
  	}
  };


  Typr.U.P = {};
  Typr.U.P.moveTo = function(p, x, y)
  {
  	p.cmds.push("M");  p.crds.push(x,y);
  };
  Typr.U.P.lineTo = function(p, x, y)
  {
  	p.cmds.push("L");  p.crds.push(x,y);
  };
  Typr.U.P.curveTo = function(p, a,b,c,d,e,f)
  {
  	p.cmds.push("C");  p.crds.push(a,b,c,d,e,f);
  };
  Typr.U.P.qcurveTo = function(p, a,b,c,d)
  {
  	p.cmds.push("Q");  p.crds.push(a,b,c,d);
  };
  Typr.U.P.closePath = function(p) {  p.cmds.push("Z");  };




  Typr.U._drawCFF = function(cmds, state, font, pdct, p)
  {
  	var stack = state.stack;
  	var nStems = state.nStems, haveWidth=state.haveWidth, width=state.width, open=state.open;
  	var i=0;
  	var x=state.x, y=state.y, c1x=0, c1y=0, c2x=0, c2y=0, c3x=0, c3y=0, c4x=0, c4y=0, jpx=0, jpy=0;
  	
  	var o = {val:0,size:0};
  	//console.log(cmds);
  	while(i<cmds.length)
  	{
  		Typr.CFF.getCharString(cmds, i, o);
  		var v = o.val;
  		i += o.size;
  			
  		if(v=="o1" || v=="o18")  //  hstem || hstemhm
  		{
  			var hasWidthArg;

  			// The number of stem operators on the stack is always even.
  			// If the value is uneven, that means a width is specified.
  			hasWidthArg = stack.length % 2 !== 0;
  			if (hasWidthArg && !haveWidth) {
  				width = stack.shift() + pdct.nominalWidthX;
  			}

  			nStems += stack.length >> 1;
  			stack.length = 0;
  			haveWidth = true;
  		}
  		else if(v=="o3" || v=="o23")  // vstem || vstemhm
  		{
  			var hasWidthArg;

  			// The number of stem operators on the stack is always even.
  			// If the value is uneven, that means a width is specified.
  			hasWidthArg = stack.length % 2 !== 0;
  			if (hasWidthArg && !haveWidth) {
  				width = stack.shift() + pdct.nominalWidthX;
  			}

  			nStems += stack.length >> 1;
  			stack.length = 0;
  			haveWidth = true;
  		}
  		else if(v=="o4")
  		{
  			if (stack.length > 1 && !haveWidth) {
                          width = stack.shift() + pdct.nominalWidthX;
                          haveWidth = true;
                      }
  			if(open) { Typr.U.P.closePath(p); }

                      y += stack.pop();
  					Typr.U.P.moveTo(p,x,y);   open=true;
  		}
  		else if(v=="o5")
  		{
  			while (stack.length > 0) {
                          x += stack.shift();
                          y += stack.shift();
                          Typr.U.P.lineTo(p, x, y);
                      }
  		}
  		else if(v=="o6" || v=="o7")  // hlineto || vlineto
  		{
  			var count = stack.length;
  			var isX = (v == "o6");
  			
  			for(var j=0; j<count; j++) {
  				var sval = stack.shift();
  				
  				if(isX) { x += sval; }  else  { y += sval; }
  				isX = !isX;
  				Typr.U.P.lineTo(p, x, y);
  			}
  		}
  		else if(v=="o8" || v=="o24")	// rrcurveto || rcurveline
  		{
  			var count = stack.length;
  			var index = 0;
  			while(index+6 <= count) {
  				c1x = x + stack.shift();
  				c1y = y + stack.shift();
  				c2x = c1x + stack.shift();
  				c2y = c1y + stack.shift();
  				x = c2x + stack.shift();
  				y = c2y + stack.shift();
  				Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, x, y);
  				index+=6;
  			}
  			if(v=="o24")
  			{
  				x += stack.shift();
  				y += stack.shift();
  				Typr.U.P.lineTo(p, x, y);
  			}
  		}
  		else if(v=="o11")  { break; }
  		else if(v=="o1234" || v=="o1235" || v=="o1236" || v=="o1237")//if((v+"").slice(0,3)=="o12")
  		{
  			if(v=="o1234")
  			{
  				c1x = x   + stack.shift();    // dx1
                  c1y = y;                      // dy1
  				c2x = c1x + stack.shift();    // dx2
  				c2y = c1y + stack.shift();    // dy2
  				jpx = c2x + stack.shift();    // dx3
  				jpy = c2y;                    // dy3
  				c3x = jpx + stack.shift();    // dx4
  				c3y = c2y;                    // dy4
  				c4x = c3x + stack.shift();    // dx5
  				c4y = y;                      // dy5
  				x = c4x + stack.shift();      // dx6
  				Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, jpx, jpy);
  				Typr.U.P.curveTo(p, c3x, c3y, c4x, c4y, x, y);
  				
  			}
  			if(v=="o1235")
  			{
  				c1x = x   + stack.shift();    // dx1
  				c1y = y   + stack.shift();    // dy1
  				c2x = c1x + stack.shift();    // dx2
  				c2y = c1y + stack.shift();    // dy2
  				jpx = c2x + stack.shift();    // dx3
  				jpy = c2y + stack.shift();    // dy3
  				c3x = jpx + stack.shift();    // dx4
  				c3y = jpy + stack.shift();    // dy4
  				c4x = c3x + stack.shift();    // dx5
  				c4y = c3y + stack.shift();    // dy5
  				x = c4x + stack.shift();      // dx6
  				y = c4y + stack.shift();      // dy6
  				stack.shift();                // flex depth
  				Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, jpx, jpy);
  				Typr.U.P.curveTo(p, c3x, c3y, c4x, c4y, x, y);
  			}
  			if(v=="o1236")
  			{
  				c1x = x   + stack.shift();    // dx1
  				c1y = y   + stack.shift();    // dy1
  				c2x = c1x + stack.shift();    // dx2
  				c2y = c1y + stack.shift();    // dy2
  				jpx = c2x + stack.shift();    // dx3
  				jpy = c2y;                    // dy3
  				c3x = jpx + stack.shift();    // dx4
  				c3y = c2y;                    // dy4
  				c4x = c3x + stack.shift();    // dx5
  				c4y = c3y + stack.shift();    // dy5
  				x = c4x + stack.shift();      // dx6
  				Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, jpx, jpy);
  				Typr.U.P.curveTo(p, c3x, c3y, c4x, c4y, x, y);
  			}
  			if(v=="o1237")
  			{
  				c1x = x   + stack.shift();    // dx1
  				c1y = y   + stack.shift();    // dy1
  				c2x = c1x + stack.shift();    // dx2
  				c2y = c1y + stack.shift();    // dy2
  				jpx = c2x + stack.shift();    // dx3
  				jpy = c2y + stack.shift();    // dy3
  				c3x = jpx + stack.shift();    // dx4
  				c3y = jpy + stack.shift();    // dy4
  				c4x = c3x + stack.shift();    // dx5
  				c4y = c3y + stack.shift();    // dy5
  				if (Math.abs(c4x - x) > Math.abs(c4y - y)) {
  				    x = c4x + stack.shift();
  				} else {
  				    y = c4y + stack.shift();
  				}
  				Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, jpx, jpy);
  				Typr.U.P.curveTo(p, c3x, c3y, c4x, c4y, x, y);
  			}
  		}
  		else if(v=="o14")
  		{
  			if (stack.length > 0 && !haveWidth) {
                          width = stack.shift() + font.nominalWidthX;
                          haveWidth = true;
                      }
  			if(stack.length==4) // seac = standard encoding accented character
  			{
  				var adx = stack.shift();
  				var ady = stack.shift();
  				var bchar = stack.shift();
  				var achar = stack.shift();
  			
  				
  				var bind = Typr.CFF.glyphBySE(font, bchar);
  				var aind = Typr.CFF.glyphBySE(font, achar);
  				
  				//console.log(bchar, bind);
  				//console.log(achar, aind);
  				//state.x=x; state.y=y; state.nStems=nStems; state.haveWidth=haveWidth; state.width=width;  state.open=open;
  				
  				Typr.U._drawCFF(font.CharStrings[bind], state,font,pdct,p);
  				state.x = adx; state.y = ady;
  				Typr.U._drawCFF(font.CharStrings[aind], state,font,pdct,p);
  				
  				//x=state.x; y=state.y; nStems=state.nStems; haveWidth=state.haveWidth; width=state.width;  open=state.open;
  			}
  			if(open) {  Typr.U.P.closePath(p);  open=false;  }
  		}		
  		else if(v=="o19" || v=="o20") 
  		{ 
  			var hasWidthArg;

  			// The number of stem operators on the stack is always even.
  			// If the value is uneven, that means a width is specified.
  			hasWidthArg = stack.length % 2 !== 0;
  			if (hasWidthArg && !haveWidth) {
  				width = stack.shift() + pdct.nominalWidthX;
  			}

  			nStems += stack.length >> 1;
  			stack.length = 0;
  			haveWidth = true;
  			
  			i += (nStems + 7) >> 3;
  		}
  		
  		else if(v=="o21") {
  			if (stack.length > 2 && !haveWidth) {
                          width = stack.shift() + pdct.nominalWidthX;
                          haveWidth = true;
                      }

                      y += stack.pop();
                      x += stack.pop();
  					
  					if(open) { Typr.U.P.closePath(p); }
                      Typr.U.P.moveTo(p,x,y);   open=true;
  		}
  		else if(v=="o22")
  		{
  			 if (stack.length > 1 && !haveWidth) {
                          width = stack.shift() + pdct.nominalWidthX;
                          haveWidth = true;
                      }
  					
                      x += stack.pop();
  					
  					if(open) { Typr.U.P.closePath(p); }
  					Typr.U.P.moveTo(p,x,y);   open=true;                    
  		}
  		else if(v=="o25")
  		{
  			while (stack.length > 6) {
                          x += stack.shift();
                          y += stack.shift();
                          Typr.U.P.lineTo(p, x, y);
                      }

                      c1x = x + stack.shift();
                      c1y = y + stack.shift();
                      c2x = c1x + stack.shift();
                      c2y = c1y + stack.shift();
                      x = c2x + stack.shift();
                      y = c2y + stack.shift();
                      Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, x, y);
  		}
  		else if(v=="o26") 
  		{
  			if (stack.length % 2) {
                          x += stack.shift();
                      }

                      while (stack.length > 0) {
                          c1x = x;
                          c1y = y + stack.shift();
                          c2x = c1x + stack.shift();
                          c2y = c1y + stack.shift();
                          x = c2x;
                          y = c2y + stack.shift();
                          Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, x, y);
                      }

  		}
  		else if(v=="o27")
  		{
  			if (stack.length % 2) {
                          y += stack.shift();
                      }

                      while (stack.length > 0) {
                          c1x = x + stack.shift();
                          c1y = y;
                          c2x = c1x + stack.shift();
                          c2y = c1y + stack.shift();
                          x = c2x + stack.shift();
                          y = c2y;
                          Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, x, y);
                      }
  		}
  		else if(v=="o10" || v=="o29")	// callsubr || callgsubr
  		{
  			var obj = (v=="o10" ? pdct : font);
  			if(stack.length==0) { console.log("error: empty stack");  }
  			else {
  				var ind = stack.pop();
  				var subr = obj.Subrs[ ind + obj.Bias ];
  				state.x=x; state.y=y; state.nStems=nStems; state.haveWidth=haveWidth; state.width=width;  state.open=open;
  				Typr.U._drawCFF(subr, state,font,pdct,p);
  				x=state.x; y=state.y; nStems=state.nStems; haveWidth=state.haveWidth; width=state.width;  open=state.open;
  			}
  		}
  		else if(v=="o30" || v=="o31")   // vhcurveto || hvcurveto
  		{
  			var count, count1 = stack.length;
  			var index = 0;
  			var alternate = v == "o31";
  			
  			count  = count1 & ~2;
  			index += count1 - count;
  			
  			while ( index < count ) 
  			{
  				if(alternate)
  				{
  					c1x = x + stack.shift();
  					c1y = y;
  					c2x = c1x + stack.shift();
  					c2y = c1y + stack.shift();
  					y = c2y + stack.shift();
  					if(count-index == 5) {  x = c2x + stack.shift();  index++;  }
  					else { x = c2x; }
  					alternate = false;
  				}
  				else
  				{
  					c1x = x;
  					c1y = y + stack.shift();
  					c2x = c1x + stack.shift();
  					c2y = c1y + stack.shift();
  					x = c2x + stack.shift();
  					if(count-index == 5) {  y = c2y + stack.shift();  index++;  }
  					else { y = c2y; }
  					alternate = true;
  				}
                  Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, x, y);
  				index += 4;
  			}
  		}
  		
  		else if((v+"").charAt(0)=="o") {   console.log("Unknown operation: "+v, cmds); throw v;  }
  		else { stack.push(v); }
  	}
  	//console.log(cmds);
  	state.x=x; state.y=y; state.nStems=nStems; state.haveWidth=haveWidth; state.width=width; state.open=open;
  };

  // End Typr.U.js

  return Typr

  }

  // Custom bundle of woff2otf (https://github.com/arty-name/woff2otf) with tiny-inflate 
  // (https://github.com/foliojs/tiny-inflate) for use in troika-3d-text. 
  // Original licenses apply: 
  // - tiny-inflate: https://github.com/foliojs/tiny-inflate/blob/master/LICENSE (MIT)
  // - woff2otf.js: https://github.com/arty-name/woff2otf/blob/master/woff2otf.js (Apache2)

  function woff2otfFactory() {

  // Begin tinyInflate
  var tinyInflate = (function() {
    var module = {};
    var TINF_OK = 0;
  var TINF_DATA_ERROR = -3;

  function Tree() {
    this.table = new Uint16Array(16);   /* table of code length counts */
    this.trans = new Uint16Array(288);  /* code -> symbol translation table */
  }

  function Data(source, dest) {
    this.source = source;
    this.sourceIndex = 0;
    this.tag = 0;
    this.bitcount = 0;
    
    this.dest = dest;
    this.destLen = 0;
    
    this.ltree = new Tree();  /* dynamic length/symbol tree */
    this.dtree = new Tree();  /* dynamic distance tree */
  }

  /* --------------------------------------------------- *
   * -- uninitialized global data (static structures) -- *
   * --------------------------------------------------- */

  var sltree = new Tree();
  var sdtree = new Tree();

  /* extra bits and base tables for length codes */
  var length_bits = new Uint8Array(30);
  var length_base = new Uint16Array(30);

  /* extra bits and base tables for distance codes */
  var dist_bits = new Uint8Array(30);
  var dist_base = new Uint16Array(30);

  /* special ordering of code length codes */
  var clcidx = new Uint8Array([
    16, 17, 18, 0, 8, 7, 9, 6,
    10, 5, 11, 4, 12, 3, 13, 2,
    14, 1, 15
  ]);

  /* used by tinf_decode_trees, avoids allocations every call */
  var code_tree = new Tree();
  var lengths = new Uint8Array(288 + 32);

  /* ----------------------- *
   * -- utility functions -- *
   * ----------------------- */

  /* build extra bits and base tables */
  function tinf_build_bits_base(bits, base, delta, first) {
    var i, sum;

    /* build bits table */
    for (i = 0; i < delta; ++i) { bits[i] = 0; }
    for (i = 0; i < 30 - delta; ++i) { bits[i + delta] = i / delta | 0; }

    /* build base table */
    for (sum = first, i = 0; i < 30; ++i) {
      base[i] = sum;
      sum += 1 << bits[i];
    }
  }

  /* build the fixed huffman trees */
  function tinf_build_fixed_trees(lt, dt) {
    var i;

    /* build fixed length tree */
    for (i = 0; i < 7; ++i) { lt.table[i] = 0; }

    lt.table[7] = 24;
    lt.table[8] = 152;
    lt.table[9] = 112;

    for (i = 0; i < 24; ++i) { lt.trans[i] = 256 + i; }
    for (i = 0; i < 144; ++i) { lt.trans[24 + i] = i; }
    for (i = 0; i < 8; ++i) { lt.trans[24 + 144 + i] = 280 + i; }
    for (i = 0; i < 112; ++i) { lt.trans[24 + 144 + 8 + i] = 144 + i; }

    /* build fixed distance tree */
    for (i = 0; i < 5; ++i) { dt.table[i] = 0; }

    dt.table[5] = 32;

    for (i = 0; i < 32; ++i) { dt.trans[i] = i; }
  }

  /* given an array of code lengths, build a tree */
  var offs = new Uint16Array(16);

  function tinf_build_tree(t, lengths, off, num) {
    var i, sum;

    /* clear code length count table */
    for (i = 0; i < 16; ++i) { t.table[i] = 0; }

    /* scan symbol lengths, and sum code length counts */
    for (i = 0; i < num; ++i) { t.table[lengths[off + i]]++; }

    t.table[0] = 0;

    /* compute offset table for distribution sort */
    for (sum = 0, i = 0; i < 16; ++i) {
      offs[i] = sum;
      sum += t.table[i];
    }

    /* create code->symbol translation table (symbols sorted by code) */
    for (i = 0; i < num; ++i) {
      if (lengths[off + i]) { t.trans[offs[lengths[off + i]]++] = i; }
    }
  }

  /* ---------------------- *
   * -- decode functions -- *
   * ---------------------- */

  /* get one bit from source stream */
  function tinf_getbit(d) {
    /* check if tag is empty */
    if (!d.bitcount--) {
      /* load next tag */
      d.tag = d.source[d.sourceIndex++];
      d.bitcount = 7;
    }

    /* shift bit out of tag */
    var bit = d.tag & 1;
    d.tag >>>= 1;

    return bit;
  }

  /* read a num bit value from a stream and add base */
  function tinf_read_bits(d, num, base) {
    if (!num)
      { return base; }

    while (d.bitcount < 24) {
      d.tag |= d.source[d.sourceIndex++] << d.bitcount;
      d.bitcount += 8;
    }

    var val = d.tag & (0xffff >>> (16 - num));
    d.tag >>>= num;
    d.bitcount -= num;
    return val + base;
  }

  /* given a data stream and a tree, decode a symbol */
  function tinf_decode_symbol(d, t) {
    while (d.bitcount < 24) {
      d.tag |= d.source[d.sourceIndex++] << d.bitcount;
      d.bitcount += 8;
    }
    
    var sum = 0, cur = 0, len = 0;
    var tag = d.tag;

    /* get more bits while code value is above sum */
    do {
      cur = 2 * cur + (tag & 1);
      tag >>>= 1;
      ++len;

      sum += t.table[len];
      cur -= t.table[len];
    } while (cur >= 0);
    
    d.tag = tag;
    d.bitcount -= len;

    return t.trans[sum + cur];
  }

  /* given a data stream, decode dynamic trees from it */
  function tinf_decode_trees(d, lt, dt) {
    var hlit, hdist, hclen;
    var i, num, length;

    /* get 5 bits HLIT (257-286) */
    hlit = tinf_read_bits(d, 5, 257);

    /* get 5 bits HDIST (1-32) */
    hdist = tinf_read_bits(d, 5, 1);

    /* get 4 bits HCLEN (4-19) */
    hclen = tinf_read_bits(d, 4, 4);

    for (i = 0; i < 19; ++i) { lengths[i] = 0; }

    /* read code lengths for code length alphabet */
    for (i = 0; i < hclen; ++i) {
      /* get 3 bits code length (0-7) */
      var clen = tinf_read_bits(d, 3, 0);
      lengths[clcidx[i]] = clen;
    }

    /* build code length tree */
    tinf_build_tree(code_tree, lengths, 0, 19);

    /* decode code lengths for the dynamic trees */
    for (num = 0; num < hlit + hdist;) {
      var sym = tinf_decode_symbol(d, code_tree);

      switch (sym) {
        case 16:
          /* copy previous code length 3-6 times (read 2 bits) */
          var prev = lengths[num - 1];
          for (length = tinf_read_bits(d, 2, 3); length; --length) {
            lengths[num++] = prev;
          }
          break;
        case 17:
          /* repeat code length 0 for 3-10 times (read 3 bits) */
          for (length = tinf_read_bits(d, 3, 3); length; --length) {
            lengths[num++] = 0;
          }
          break;
        case 18:
          /* repeat code length 0 for 11-138 times (read 7 bits) */
          for (length = tinf_read_bits(d, 7, 11); length; --length) {
            lengths[num++] = 0;
          }
          break;
        default:
          /* values 0-15 represent the actual code lengths */
          lengths[num++] = sym;
          break;
      }
    }

    /* build dynamic trees */
    tinf_build_tree(lt, lengths, 0, hlit);
    tinf_build_tree(dt, lengths, hlit, hdist);
  }

  /* ----------------------------- *
   * -- block inflate functions -- *
   * ----------------------------- */

  /* given a stream and two trees, inflate a block of data */
  function tinf_inflate_block_data(d, lt, dt) {
    while (1) {
      var sym = tinf_decode_symbol(d, lt);

      /* check for end of block */
      if (sym === 256) {
        return TINF_OK;
      }

      if (sym < 256) {
        d.dest[d.destLen++] = sym;
      } else {
        var length, dist, offs;
        var i;

        sym -= 257;

        /* possibly get more bits from length code */
        length = tinf_read_bits(d, length_bits[sym], length_base[sym]);

        dist = tinf_decode_symbol(d, dt);

        /* possibly get more bits from distance code */
        offs = d.destLen - tinf_read_bits(d, dist_bits[dist], dist_base[dist]);

        /* copy match */
        for (i = offs; i < offs + length; ++i) {
          d.dest[d.destLen++] = d.dest[i];
        }
      }
    }
  }

  /* inflate an uncompressed block of data */
  function tinf_inflate_uncompressed_block(d) {
    var length, invlength;
    var i;
    
    /* unread from bitbuffer */
    while (d.bitcount > 8) {
      d.sourceIndex--;
      d.bitcount -= 8;
    }

    /* get length */
    length = d.source[d.sourceIndex + 1];
    length = 256 * length + d.source[d.sourceIndex];

    /* get one's complement of length */
    invlength = d.source[d.sourceIndex + 3];
    invlength = 256 * invlength + d.source[d.sourceIndex + 2];

    /* check length */
    if (length !== (~invlength & 0x0000ffff))
      { return TINF_DATA_ERROR; }

    d.sourceIndex += 4;

    /* copy block */
    for (i = length; i; --i)
      { d.dest[d.destLen++] = d.source[d.sourceIndex++]; }

    /* make sure we start next block on a byte boundary */
    d.bitcount = 0;

    return TINF_OK;
  }

  /* inflate stream from source to dest */
  function tinf_uncompress(source, dest) {
    var d = new Data(source, dest);
    var bfinal, btype, res;

    do {
      /* read final block flag */
      bfinal = tinf_getbit(d);

      /* read block type (2 bits) */
      btype = tinf_read_bits(d, 2, 0);

      /* decompress block */
      switch (btype) {
        case 0:
          /* decompress uncompressed block */
          res = tinf_inflate_uncompressed_block(d);
          break;
        case 1:
          /* decompress block with fixed huffman trees */
          res = tinf_inflate_block_data(d, sltree, sdtree);
          break;
        case 2:
          /* decompress block with dynamic huffman trees */
          tinf_decode_trees(d, d.ltree, d.dtree);
          res = tinf_inflate_block_data(d, d.ltree, d.dtree);
          break;
        default:
          res = TINF_DATA_ERROR;
      }

      if (res !== TINF_OK)
        { throw new Error('Data error'); }

    } while (!bfinal);

    if (d.destLen < d.dest.length) {
      if (typeof d.dest.slice === 'function')
        { return d.dest.slice(0, d.destLen); }
      else
        { return d.dest.subarray(0, d.destLen); }
    }
    
    return d.dest;
  }

  /* -------------------- *
   * -- initialization -- *
   * -------------------- */

  /* build fixed huffman trees */
  tinf_build_fixed_trees(sltree, sdtree);

  /* build extra bits and base tables */
  tinf_build_bits_base(length_bits, length_base, 4, 3);
  tinf_build_bits_base(dist_bits, dist_base, 2, 1);

  /* fix a special case */
  length_bits[28] = 0;
  length_base[28] = 258;

  module.exports = tinf_uncompress;

    return module.exports
  })();
  // End tinyInflate

  // Begin woff2otf.js
  /*
   Copyright 2012, Steffen Hanikel (https://github.com/hanikesn)
   Modified by Artemy Tregubenko, 2014 (https://github.com/arty-name/woff2otf)
   Modified by Jason Johnston, 2019 (pako --> tiny-inflate)
   
     Licensed under the Apache License, Version 2.0 (the "License");
     you may not use this file except in compliance with the License.
     You may obtain a copy of the License at

         http://www.apache.org/licenses/LICENSE-2.0

     Unless required by applicable law or agreed to in writing, software
     distributed under the License is distributed on an "AS IS" BASIS,
     WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     See the License for the specific language governing permissions and
     limitations under the License.

   A tool to convert a WOFF back to a TTF/OTF font file, in pure Javascript
  */

  function convert_streams(bufferIn, tinyInflate) {
      var dataViewIn = new DataView(bufferIn);
      var offsetIn = 0;

      function read2() {
          var uint16 = dataViewIn.getUint16(offsetIn);
          offsetIn += 2;
          return uint16;
      }

      function read4() {
          var uint32 = dataViewIn.getUint32(offsetIn);
          offsetIn += 4;
          return uint32;
      }

      function write2(uint16) {
          dataViewOut.setUint16(offsetOut, uint16);
          offsetOut += 2;
      }

      function write4(uint32) {
          dataViewOut.setUint32(offsetOut, uint32);
          offsetOut += 4;
      }

      var WOFFHeader = {
          signature: read4(),
          flavor: read4(),
          length: read4(),
          numTables: read2(),
          reserved: read2(),
          totalSfntSize: read4(),
          majorVersion: read2(),
          minorVersion: read2(),
          metaOffset: read4(),
          metaLength: read4(),
          metaOrigLength: read4(),
          privOffset: read4(),
          privLength: read4()
      };

      var entrySelector = 0;
      while (Math.pow(2, entrySelector) <= WOFFHeader.numTables) {
          entrySelector++;
      }
      entrySelector--;

      var searchRange = Math.pow(2, entrySelector) * 16;
      var rangeShift = WOFFHeader.numTables * 16 - searchRange;

      var offset = 4 + 2 + 2 + 2 + 2;
      var TableDirectoryEntries = [];
      for (var i = 0; i < WOFFHeader.numTables; i++) {
          TableDirectoryEntries.push({
              tag: read4(),
              offset: read4(),
              compLength: read4(),
              origLength: read4(),
              origChecksum: read4()
          });
          offset += 4 * 4;
      }

      var arrayOut = new Uint8Array(
          4 + 2 + 2 + 2 + 2 +
          TableDirectoryEntries.length * (4 + 4 + 4 + 4) +
          TableDirectoryEntries.reduce(function(acc, entry) { return acc + entry.origLength + 4; }, 0)
      );
      var bufferOut = arrayOut.buffer;
      var dataViewOut = new DataView(bufferOut);
      var offsetOut = 0;

      write4(WOFFHeader.flavor);
      write2(WOFFHeader.numTables);
      write2(searchRange);
      write2(entrySelector);
      write2(rangeShift);

      TableDirectoryEntries.forEach(function(TableDirectoryEntry) {
          write4(TableDirectoryEntry.tag);
          write4(TableDirectoryEntry.origChecksum);
          write4(offset);
          write4(TableDirectoryEntry.origLength);

          TableDirectoryEntry.outOffset = offset;
          offset += TableDirectoryEntry.origLength;
          if ((offset % 4) != 0) {
              offset += 4 - (offset % 4);
          }
      });

      var size;

      TableDirectoryEntries.forEach(function(TableDirectoryEntry) {
          var compressedData = bufferIn.slice(
              TableDirectoryEntry.offset,
              TableDirectoryEntry.offset + TableDirectoryEntry.compLength
          );

          if (TableDirectoryEntry.compLength != TableDirectoryEntry.origLength) {
              var uncompressedData = new Uint8Array(TableDirectoryEntry.origLength);
              tinyInflate(
                new Uint8Array(compressedData, 2), //skip deflate header
                uncompressedData
              );
          } else {
              uncompressedData = new Uint8Array(compressedData);
          }

          arrayOut.set(uncompressedData, TableDirectoryEntry.outOffset);
          offset = TableDirectoryEntry.outOffset + TableDirectoryEntry.origLength;

          var padding = 0;
          if ((offset % 4) != 0) {
              padding = 4 - (offset % 4);
          }
          arrayOut.set(
              new Uint8Array(padding).buffer,
              TableDirectoryEntry.outOffset + TableDirectoryEntry.origLength
          );

          size = offset + padding;
      });

      return bufferOut.slice(0, size);
  }

  // End woff2otf.js

  return function(buffer) {
    return convert_streams(buffer, tinyInflate)
  }

  }

  /**
   * An adapter that allows Typr.js to be used as if it were (a subset of) the OpenType.js API.
   * Also adds support for WOFF files (not WOFF2).
   */

  function parserFactory(Typr, woff2otf) {
    var cmdArgLengths = {
      M: 2,
      L: 2,
      Q: 4,
      C: 6,
      Z: 0
    };

    function wrapFontObj(ref) {
      var typrFont = ref[0];

      var glyphMap = Object.create(null);

      var fontObj = {
        unitsPerEm: typrFont.head.unitsPerEm,
        ascender: typrFont.hhea.ascender,
        descender: typrFont.hhea.descender,
        forEachGlyph: function forEachGlyph(text, fontSize, letterSpacing, callback) {
          var glyphX = 0;
          var fontScale = 1 / fontObj.unitsPerEm * fontSize;

          var glyphIndices = Typr.U.stringToGlyphs(typrFont, text);
          glyphIndices.forEach(function (glyphIndex) {
            if (glyphIndex === -1) { return } //Typr leaves -1s in the array after ligature substitution

            var glyphObj = glyphMap[glyphIndex];
            if (!glyphObj) {
              // !!! NOTE: Typr doesn't expose a public accessor for the glyph data, so this just
              // copies how it parses that data in Typr.U._drawGlyf -- this may be fragile.
              var typrGlyph = Typr.glyf._parseGlyf(typrFont, glyphIndex) || {xMin: 0, xMax: 0, yMin: 0, yMax: 0};
              var ref = Typr.U.glyphToPath(typrFont, glyphIndex);
              var cmds = ref.cmds;
              var crds = ref.crds;

              glyphObj = glyphMap[glyphIndex] = {
                index: glyphIndex,
                unicode: getUnicodeForGlyph(typrFont, glyphIndex),
                advanceWidth: typrFont.hmtx.aWidth[glyphIndex],
                xMin: typrGlyph.xMin,
                yMin: typrGlyph.yMin,
                xMax: typrGlyph.xMax,
                yMax: typrGlyph.yMax,
                pathCommandCount: cmds.length,
                forEachPathCommand: function forEachPathCommand(callback) {
                  var argsIndex = 0;
                  var argsArray = [];
                  for (var i = 0, len = cmds.length; i < len; i++) {
                    var numArgs = cmdArgLengths[cmds[i]];
                    argsArray.length = 1 + numArgs;
                    argsArray[0] = cmds[i];
                    for (var j = 1; j <= numArgs; j++) {
                      argsArray[j] = crds[argsIndex++];
                    }
                    callback.apply(null, argsArray);
                  }
                }
              };
            }

            callback.call(null, glyphObj, glyphX);

            if (glyphObj.advanceWidth) {
              glyphX += glyphObj.advanceWidth * fontScale;
            }
            if (letterSpacing) {
              glyphX += letterSpacing * fontSize;
            }
          });
          return glyphX
        }
      };

      return fontObj
    }


    function getUnicodeForGlyph(typrFont, glyphIndex) {
      var glyphToUnicodeMap = typrFont.glyphToUnicodeMap;
      if (!glyphToUnicodeMap) {
        glyphToUnicodeMap = typrFont.glyphToUnicodeMap = Object.create(null);

        // NOTE: this logic for traversing the cmap table formats follows that in Typr.U.codeToGlyph
        var cmap = typrFont.cmap;

        var tableIndex = -1;
        if (cmap.p0e4 != null) { tableIndex = cmap.p0e4; }
        else if (cmap.p3e1 != null) { tableIndex = cmap.p3e1; }
        else if (cmap.p1e0 != null) { tableIndex = cmap.p1e0; }
        else if (cmap.p0e3 != null) { tableIndex = cmap.p0e3; }
        if (tableIndex === -1) {
          throw "no familiar platform and encoding!"
        }
        var table = cmap.tables[tableIndex];

        if (table.format === 0) {
          for (var code = 0; code < table.map.length; code++) {
            glyphToUnicodeMap[table.map[code]] = code;
          }
        }
        else if (table.format === 4) {
          var startCodes = table.startCount;
          var endCodes = table.endCount;
          for (var i = 0; i < startCodes.length; i++) {
            for (var code$1 = startCodes[i]; code$1 <= endCodes[i]; code$1++) {
              glyphToUnicodeMap[Typr.U.codeToGlyph(typrFont, code$1)] = code$1;
            }
          }
        }
        else if (table.format === 12)
        {
          table.groups.forEach(function (ref) {
            var startCharCode = ref[0];
            var endCharCode = ref[1];
            var startGlyphID = ref[2];

            var glyphId = startGlyphID;
            for (var code = startCharCode; code <= endCharCode; code++) {
              glyphToUnicodeMap[glyphId++] = code;
            }
          });
        }
        else {
          throw "unknown cmap table format " + table.format
        }
      }
      return glyphToUnicodeMap[glyphIndex] || 0
    }


    return function parse(buffer) {
      // Look to see if we have a WOFF file and convert it if so:
      var peek = new Uint8Array(buffer, 0, 4);
      var tag = Typr._bin.readASCII(peek, 0, 4);
      if (tag === 'wOFF') {
        buffer = woff2otf(buffer);
      } else if (tag === 'wOF2') {
        throw new Error('woff2 fonts not supported')
      }
      return wrapFontObj(Typr.parse(buffer))
    }
  }


  var workerModule = defineWorkerModule({
    dependencies: [typrFactory, woff2otfFactory, parserFactory],
    init: function init(typrFactory, woff2otfFactory, parserFactory) {
      var Typr = typrFactory();
      var woff2otf = woff2otfFactory();
      return parserFactory(Typr, woff2otf)
    }
  });

  //import fontParser from './FontParser_OpenType.js'


  var CONFIG = {
    defaultFontURL: 'https://fonts.gstatic.com/s/roboto/v18/KFOmCnqEu92Fr1Mu4mxM.woff', //Roboto Regular
    sdfGlyphSize: 64
  };
  var linkEl = document.createElement('a'); //for resolving relative URLs to absolute


  /**
   * How many glyphs the font's SDF texture should initially be created to hold.
   */
  var SDF_INITIAL_GLYPH_COUNT = 64;

  /**
   * The radial distance from glyph edges over which the SDF alpha will be calculated; if the alpha
   * at distance:0 is 0.5, then the alpha at this distance will be zero. This is defined as a percentage
   * of each glyph's maximum dimension in font space units so that it maps to the same minimum number of
   * SDF texels regardless of the glyph's size. A larger value provides greater alpha gradient resolution
   * and improves readability/antialiasing quality at small display sizes, but also decreases the number
   * of texels available for encoding path details.
   */
  var SDF_DISTANCE_PERCENT = 1 / 8;


  /**
   * Repository for all font SDF atlas textures
   *
   *   {
   *     [font]: {
   *       sdfTexture: DataTexture
   *     }
   *   }
   */
  var atlases = Object.create(null);


  /**
   * Main entry point for requesting the data needed to render a text string with given font parameters.
   * This is an asynchronous call, performing most of the logic in a web worker thread.
   * @param args
   * @param callback
   */
  function getTextRenderInfo(args, callback) {
    args = assign$1({}, args);

    // Apply default font here to avoid a 'null' atlas, and convert relative
    // URLs to absolute so they can be resolved in the worker
    linkEl.href = args.font || CONFIG.defaultFontURL;
    args.font = linkEl.href;

    // Normalize text to a string
    args.text = '' + args.text;

    // Init the atlas for this font if needed
    var sdfGlyphSize = CONFIG.sdfGlyphSize;
    var atlas = atlases[args.font];
    if (!atlas) {
      atlas = atlases[args.font] = {
        sdfTexture: new three.DataTexture(
          new Uint8Array(sdfGlyphSize * sdfGlyphSize * SDF_INITIAL_GLYPH_COUNT),
          sdfGlyphSize,
          sdfGlyphSize * SDF_INITIAL_GLYPH_COUNT,
          three.LuminanceFormat,
          undefined,
          undefined,
          undefined,
          undefined,
          three.LinearFilter,
          three.LinearFilter
        )
      };
      atlas.sdfTexture.font = args.font;
    }

    // Issue request to the FontProcessor in the worker
    processInWorker(args).then(function (result) {
      // If the response has newGlyphs, copy them into the atlas texture at the specified indices
      if (result.newGlyphSDFs) {
        result.newGlyphSDFs.forEach(function (ref) {
          var textureData = ref.textureData;
          var atlasIndex = ref.atlasIndex;

          var texImg = atlas.sdfTexture.image;
          var arrayOffset = atlasIndex * sdfGlyphSize * sdfGlyphSize;

          // Grow the texture by power of 2 if needed
          while (arrayOffset > texImg.data.length - 1) {
            var biggerArray = new Uint8Array(texImg.data.length * 2);
            biggerArray.set(texImg.data);
            texImg.data = biggerArray;
            texImg.height *= 2;
          }

          // Insert the new glyph's data at the proper index
          texImg.data.set(textureData, arrayOffset);
        });
        atlas.sdfTexture.needsUpdate = true;
      }

      // Invoke callback with the text layout arrays and updated texture
      callback({
        sdfTexture: atlas.sdfTexture,
        sdfMinDistancePercent: SDF_DISTANCE_PERCENT,
        glyphBounds: result.glyphBounds,
        glyphIndices: result.glyphIndices,
        totalBounds: result.totalBounds,
        totalBlockSize: result.totalBlockSize
      });
    });
  }

  // Local assign impl so we don't have to import troika-core
  function assign$1(toObj, fromObj) {
    for (var key in fromObj) {
      if (fromObj.hasOwnProperty(key)) {
        toObj[key] = fromObj[key];
      }
    }
    return toObj
  }


  var fontProcessorWorkerModule = defineWorkerModule({
    dependencies: [
      CONFIG,
      SDF_DISTANCE_PERCENT,
      workerModule,
      createSDFGenerator,
      createFontProcessor
    ],
    init: function init(config, sdfDistancePercent, fontParser, createSDFGenerator, createFontProcessor) {
      var sdfGenerator = createSDFGenerator({
        sdfTextureSize: config.sdfGlyphSize,
        sdfDistancePercent: sdfDistancePercent
      });
      return createFontProcessor(fontParser, sdfGenerator, {
        defaultFontUrl: config.defaultFontURL
      })
    }
  });

  var processInWorker = defineWorkerModule({
    dependencies: [fontProcessorWorkerModule, ThenableWorkerModule],
    init: function init(fontProcessor, Thenable) {
      return function(args) {
        var thenable = new Thenable();
        fontProcessor.process(args, thenable.resolve);
        return thenable
      }
    },
    getTransferables: function getTransferables(result) {
      // Mark array buffers as transferable to avoid cloning during postMessage
      var transferables = [result.glyphBounds.buffer, result.glyphIndices.buffer];
      if (result.newGlyphSDFs) {
        result.newGlyphSDFs.forEach(function (d) {
          transferables.push(d.textureData.buffer);
        });
      }
      return transferables
    }
  });

  var templateGeometry = new three.PlaneBufferGeometry(1, 1).translate(0.5, 0.5, 0);
  var tempVec3 = new three.Vector3();

  var glyphBoundsAttrName = 'aTroikaGlyphBounds';
  var glyphIndexAttrName = 'aTroikaGlyphIndex';



  /**
  @class GlyphsGeometry

  A specialized Geometry for rendering a set of text glyphs. Uses InstancedBufferGeometry to
  render the glyphs using GPU instancing of a single quad, rather than constructing a whole
  geometry with vertices, for much smaller attribute arraybuffers according to this math:

    Where N = number of glyphs...

    Instanced:
    - position: 4 * 3
    - index: 2 * 3
    - normal: 4 * 3
    - uv: 4 * 2
    - glyph x/y bounds: N * 4
    - glyph indices: N * 1
    = 5N + 38

    Non-instanced:
    - position: N * 4 * 3
    - index: N * 2 * 3
    - normal: N * 4 * 3
    - uv: N * 4 * 2
    - glyph indices: N * 1
    = 39N

  A downside of this is the rare-but-possible lack of the instanced arrays extension,
  which we could potentially work around with a fallback non-instanced implementation.

  */
  var GlyphsGeometry = (function (InstancedBufferGeometry) {
    function GlyphsGeometry() {
      InstancedBufferGeometry.call(this);

      // Base per-instance attributes
      this.copy(templateGeometry);

      // Add our custom instanced attributes
      this.addAttribute(
        glyphBoundsAttrName,
        new three.InstancedBufferAttribute(new Float32Array(0), 4)
      );
      this.addAttribute(
        glyphIndexAttrName,
        new three.InstancedBufferAttribute(new Float32Array(0), 1)
      );

      // Preallocate zero-radius bounding sphere
      this.boundingSphere = new three.Sphere();
    }

    if ( InstancedBufferGeometry ) GlyphsGeometry.__proto__ = InstancedBufferGeometry;
    GlyphsGeometry.prototype = Object.create( InstancedBufferGeometry && InstancedBufferGeometry.prototype );
    GlyphsGeometry.prototype.constructor = GlyphsGeometry;

    GlyphsGeometry.prototype.computeBoundingSphere = function computeBoundingSphere () {
      // No-op; we'll sync the boundingSphere proactively in `updateGlyphs`.
    };

    /**
     * Update the geometry for a new set of glyphs.
     * @param {Float32Array} glyphBounds - An array holding the planar bounds for all glyphs
     *        to be rendered, 4 entries for each glyph: x1,x2,y1,y1
     * @param {Float32Array} glyphIndices - An array holding the index of each glyph within
     *        the SDF atlas texture.
     * @param {Array} totalBounds - An array holding the [minX, minY, maxX, maxY] across all glyphs
     */
    GlyphsGeometry.prototype.updateGlyphs = function updateGlyphs (glyphBounds, glyphIndices, totalBounds) {
      // Update the instance attributes
      updateBufferAttrArray(this.attributes[glyphBoundsAttrName], glyphBounds);
      updateBufferAttrArray(this.attributes[glyphIndexAttrName], glyphIndices);
      this.maxInstancedCount = glyphIndices.length;

      // Update the boundingSphere based on the total bounds
      var sphere = this.boundingSphere;
      sphere.center.set(
        (totalBounds[0] + totalBounds[2]) / 2,
        (totalBounds[1] + totalBounds[3]) / 2,
        0
      );
      sphere.radius = sphere.center.distanceTo(tempVec3.set(totalBounds[0], totalBounds[1], 0));
    };

    return GlyphsGeometry;
  }(three.InstancedBufferGeometry));



  function updateBufferAttrArray(attr, newArray) {
    if (attr.array.length === newArray.length) {
      attr.array.set(newArray);
    } else {
      attr.setArray(newArray);
    }
    attr.needsUpdate = true;
  }

  var VERTEX_DEFS = "\nuniform float uTroikaGlyphVSize;\nuniform vec4 uTroikaTotalBounds;\nattribute vec4 aTroikaGlyphBounds;\nattribute float aTroikaGlyphIndex;\nvarying vec2 vTroikaGlyphUV;\nvarying vec3 vTroikaLocalPos;\n";

  var VERTEX_TRANSFORM = "\nvTroikaGlyphUV = vec2(\n  position.x,\n  uTroikaGlyphVSize * (aTroikaGlyphIndex + position.y)\n);\n\nposition = vec3(\n  mix(aTroikaGlyphBounds.x, aTroikaGlyphBounds.z, position.x),\n  mix(aTroikaGlyphBounds.y, aTroikaGlyphBounds.w, position.y),\n  position.z\n);\nvTroikaLocalPos = vec3(position);\n\nuv = vec2(\n  (position.x - uTroikaTotalBounds.x) / (uTroikaTotalBounds.z - uTroikaTotalBounds.x),\n  (position.y - uTroikaTotalBounds.y) / (uTroikaTotalBounds.w - uTroikaTotalBounds.y)\n);\n";

  var FRAGMENT_DEFS = "\nuniform sampler2D uTroikaSDFTexture;\nuniform float uTroikaSDFMinDistancePct;\nuniform bool uTroikaSDFDebug;\nuniform float uTroikaGlyphVSize;\nuniform vec4 uTroikaClipRect;\nvarying vec2 vTroikaGlyphUV;\nvarying vec3 vTroikaLocalPos;\n\nvoid troikaApplyClipping() {\n  vec4 rect = uTroikaClipRect;\n  vec3 pos = vTroikaLocalPos;\n  if (rect != vec4(.0,.0,.0,.0) && (\n    pos.x < min(rect.x, rect.z) || \n    pos.y < min(rect.y, rect.w) ||\n    pos.x > max(rect.x, rect.z) ||\n    pos.y > max(rect.y, rect.w)\n  )) {\n    discard;\n  }\n}\n";

  var FRAGMENT_TRANSFORM = "\ntroikaApplyClipping();\n\nfloat troikaSDFValue = texture2D(uTroikaSDFTexture, vTroikaGlyphUV).r;\n\n" + ('') + "\n#if defined(GL_OES_standard_derivatives) || __VERSION__ >= 300\n  float troikaAntiAliasDist = min(\n    0.5,\n    0.5 * min(\n      fwidth(vTroikaGlyphUV.x), \n      fwidth(vTroikaGlyphUV.y / uTroikaGlyphVSize)\n    )\n  ) / uTroikaSDFMinDistancePct;\n#else\n  float troikaAntiAliasDist = 0.01;\n#endif\n\nfloat textAlphaMult = uTroikaSDFDebug ? troikaSDFValue : smoothstep(\n  0.5 - troikaAntiAliasDist,\n  0.5 + troikaAntiAliasDist,\n  troikaSDFValue\n);\nif (textAlphaMult == 0.0) {\n  if (uTroikaSDFDebug) {\n    gl_FragColor *= 0.5;\n  } else {\n    discard;\n  }\n} else {\n  gl_FragColor.a *= textAlphaMult;\n}\n";


  /**
   * Create a material for rendering text, derived from a baseMaterial
   */
  function createTextDerivedMaterial(baseMaterial) {
    var textMaterial = createDerivedMaterial(baseMaterial, {
      extensions: {derivatives: true},
      uniforms: {
        uTroikaSDFTexture: {value: null},
        uTroikaSDFMinDistancePct: {value: 0},
        uTroikaGlyphVSize: {value: 0},
        uTroikaTotalBounds: {value: new three.Vector4()},
        uTroikaClipRect: {value: new three.Vector4()},
        uTroikaSDFDebug: {value: false}
      },
      vertexDefs: VERTEX_DEFS,
      vertexTransform: VERTEX_TRANSFORM,
      fragmentDefs: FRAGMENT_DEFS,
      fragmentColorTransform: FRAGMENT_TRANSFORM
    });

    //force transparency - TODO is this reasonable?
    textMaterial.transparent = true;

    return textMaterial
  }

  var defaultMaterial = new three.MeshBasicMaterial({
    color: 0xffffff,
    side: three.DoubleSide,
    transparent: true
  });

  var noclip = Object.freeze([0, 0, 0, 0]);

  var tempMat4 = new three.Matrix4();

  var raycastMesh = new three.Mesh(
    new three.PlaneBufferGeometry(1, 1).translate(0.5, 0.5, 0),
    defaultMaterial
  );




  /**
   * @class TextMesh
   *
   * A ThreeJS Mesh that renders a string of text on a plane in 3D space using signed distance
   * fields (SDF).
   */
  var TextMesh = (function (Mesh) {
    function TextMesh(material) {
      var geometry = new GlyphsGeometry();
      Mesh.call(this, geometry, null);

      // === Text layout properties: === //

      /**
       * @member {string} text
       * The string of text to be rendered.
       */
      this.text = '';

      /**
       * @member {Array<number>} anchor
       * Defines where in the text block should correspond to the mesh's local position, as a set
       * of horizontal and vertical percentages from 0 to 1. A value of `[0, 0]` (the default)
       * anchors at the top-left, `[1, 1]` at the bottom-right, and `[0.5, 0.5]` centers the
       * block at the mesh's position.
       */
      this.anchor = null;

      /**
       * @member {string} font
       * URL of a custom font to be used. Font files can be any of the formats supported by
       * OpenType (see https://github.com/opentypejs/opentype.js).
       * Defaults to the Roboto font loaded from Google Fonts.
       */
      this.font = null; //will use default from TextBuilder

      /**
       * @member {number} fontSize
       * The size at which to render the font in local units; corresponds to the em-box height
       * of the chosen `font`.
       */
      this.fontSize = 0.1;

      /**
       * @member {number} letterSpacing
       * Sets a uniform adjustment to spacing between letters after kerning is applied. Positive
       * numbers increase spacing and negative numbers decrease it.
       */
      this.letterSpacing = 0;

      /**
       * @member {number|string} lineHeight
       * Sets the height of each line of text, as a multiple of the `fontSize`. Defaults to 'normal'
       * which chooses a reasonable height based on the chosen font's ascender/descender metrics.
       */
      this.lineHeight = 'normal';

      /**
       * @member {number} maxWidth
       * The maximum width of the text block, above which text may start wrapping according to the
       * `whiteSpace` and `overflowWrap` properties.
       */
      this.maxWidth = Infinity;

      /**
       * @member {string} overflowWrap
       * Defines how text wraps if the `whiteSpace` property is `normal`. Can be either `'normal'`
       * to break at whitespace characters, or `'break-word'` to allow breaking within words.
       * Defaults to `'normal'`.
       */
      this.overflowWrap = 'normal';

      /**
       * @member {string} textAlign
       * The horizontal alignment of each line of text within the overall text bounding box.
       */
      this.textAlign = 'left';

      /**
       * @member {string} whiteSpace
       * Defines whether text should wrap when a line reaches the `maxWidth`. Can
       * be either `'normal'` (the default), to allow wrapping according to the `overflowWrap` property,
       * or `'nowrap'` to prevent wrapping. Note that `'normal'` here honors newline characters to
       * manually break lines, making it behave more like `'pre-wrap'` does in CSS.
       */
      this.whiteSpace = 'normal';


      // === Presentation properties: === //

      /**
       * @member {THREE.Material} material
       * Defines a _base_ material to be used when rendering the text. This material will be
       * automatically replaced with a material derived from it, that adds shader code to
       * decrease the alpha for each fragment (pixel) outside the text glyphs, with antialiasing.
       * By default it will derive from a simple white MeshBasicMaterial, but you can use any
       * of the other mesh materials to gain other features like lighting, texture maps, etc.
       *
       * Also see the `color` shortcut property.
       */
      this.material = null;

      /**
       * @member {string|number|THREE.Color} color
       * This is a shortcut for setting the `color` of the text's material. You can use this
       * if you don't want to specify a whole custom `material`.
       */
      this.color = null;

      /**
       * @member {number} depthOffset
       * This is a shortcut for setting the material's `polygonOffset` and related properties,
       * which can be useful in preventing z-fighting when this text is laid on top of another
       * plane in the scene. Positive numbers are further from the camera, negatives closer.
       */
      this.depthOffset = 0;

      /**
       * @member {Array<number>} clipRect
       * If specified, defines a `[minX, minY, maxX, maxY]` of a rectangle outside of which all
       * pixels will be discarded. This can be used for example to clip overflowing text when
       * `whiteSpace='nowrap'`.
       */
      this.clipRect = null;

      this.debugSDF = false;
    }

    if ( Mesh ) TextMesh.__proto__ = Mesh;
    TextMesh.prototype = Object.create( Mesh && Mesh.prototype );
    TextMesh.prototype.constructor = TextMesh;

    var prototypeAccessors = { material: { configurable: true } };

    /**
     * Updates the text rendering according to the current text-related configuration properties.
     * This is an async process, so you can pass in a callback function to be executed when it
     * finishes.
     * @param {function} [callback]
     */
    TextMesh.prototype.sync = function sync (callback) {
      var this$1 = this;

      if (this._needsSync) {
        this._needsSync = false;

        // If there's another sync still in progress, queue
        if (this._isSyncing) {
          (this._queuedSyncs || (this._queuedSyncs = [])).push(callback);
        } else {
          this._isSyncing = true;

          getTextRenderInfo({
            text: this.text,
            font: this.font,
            fontSize: this.fontSize,
            letterSpacing: this.letterSpacing,
            lineHeight: this.lineHeight,
            maxWidth: this.maxWidth,
            textAlign: this.textAlign,
            whiteSpace: this.whiteSpace,
            overflowWrap: this.overflowWrap,
            anchor: this.anchor
          }, function (textRenderInfo) {
            this$1._isSyncing = false;

            // Save result for later use in onBeforeRender
            this$1._textRenderInfo = textRenderInfo;

            // Update the geometry attributes
            this$1.geometry.updateGlyphs(textRenderInfo.glyphBounds, textRenderInfo.glyphIndices, textRenderInfo.totalBounds);

            // If we had extra sync requests queued up, kick it off
            var queued = this$1._queuedSyncs;
            if (queued) {
              this$1._queuedSyncs = null;
              this$1._needsSync = true;
              this$1.sync(function () {
                queued.forEach(function (fn) { return fn && fn(); });
              });
            }

            if (callback) {
              callback();
            }
          });
        }
      }
    };

    /**
     * Initiate a sync if needed - note it won't complete until next frame at the
     * earliest so if possible it's a good idea to call sync() manually as soon as
     * all the properties have been set.
     * @override
     */
    TextMesh.prototype.onBeforeRender = function onBeforeRender () {
      this.sync();
      this._prepareMaterial();
    };

    /**
     * Shortcut to dispose the geometry specific to this instance.
     * Note: we don't also dispose the derived material here because if anything else is
     * sharing the same base material it will result in a pause next frame as the program
     * is recompiled. Instead users can dispose the base material manually, like normal,
     * and we'll also dispose the derived material at that time.
     */
    TextMesh.prototype.dispose = function dispose () {
      this.geometry.dispose();
    };


    // Handler for automatically wrapping the base material with our upgrades. We do the wrapping
    // lazily on _read_ rather than write to avoid unnecessary wrapping on transient values.
    prototypeAccessors.material.get = function () {
      var derivedMaterial = this._derivedMaterial;
      var baseMaterial = this._baseMaterial || defaultMaterial;
      if (!derivedMaterial || derivedMaterial.baseMaterial !== baseMaterial) {
        if (derivedMaterial) {
          derivedMaterial.dispose();
        }
        derivedMaterial = this._derivedMaterial = createTextDerivedMaterial(baseMaterial);
        // dispose the derived material when its base material is disposed:
        baseMaterial.addEventListener('dispose', function onDispose() {
          baseMaterial.removeEventListener('dispose', onDispose);
          derivedMaterial.dispose();
        });
      }
      return derivedMaterial
    };
    prototypeAccessors.material.set = function (baseMaterial) {
      this._baseMaterial = baseMaterial;
    };

    TextMesh.prototype._prepareMaterial = function _prepareMaterial () {
      var material = this._derivedMaterial;
      var textInfo = this._textRenderInfo;
      var uniforms = material.uniforms;
      if (textInfo) {
        var sdfTexture = textInfo.sdfTexture;
        uniforms.uTroikaSDFTexture.value = sdfTexture;
        uniforms.uTroikaSDFMinDistancePct.value = textInfo.sdfMinDistancePercent;
        uniforms.uTroikaGlyphVSize.value = sdfTexture.image.width / sdfTexture.image.height;
        uniforms.uTroikaTotalBounds.value.fromArray(textInfo.totalBounds);
      }
      uniforms.uTroikaSDFDebug.value = !!this.debugSDF;

      var clipRect = this.clipRect;
      if (!(clipRect && Array.isArray(clipRect) && clipRect.length === 4)) { clipRect = noclip; }
      uniforms.uTroikaClipRect.value.fromArray(clipRect);

      material.polygonOffset = !!this.depthOffset;
      material.polygonOffsetFactor = material.polygonOffsetUnits = this.depthOffset || 0;

      // shortcut for setting material color via facade prop:
      var color = this.color;
      if (color != null && material.color && material.color.isColor && color !== material._troikaColor) {
        material.color.set(material._troikaColor = color);
      }
    };

    /**
     * @override Custom raycasting to test against the whole text block's max rectangular bounds
     * TODO is there any reason to make this more granular, like within individual line or glyph rects?
     */
    TextMesh.prototype.raycast = function raycast (raycaster, intersects) {
      var textInfo = this._textRenderInfo;
      if (textInfo) {
        var bounds = textInfo.totalBounds;
        raycastMesh.matrixWorld.multiplyMatrices(
          this.matrixWorld,
          tempMat4.set(
            bounds[2] - bounds[0], 0, 0, bounds[0],
            0, bounds[3] - bounds[1], 0, bounds[1],
            0, 0, 1, 0,
            0, 0, 0, 1
          )
        );
        raycastMesh.raycast(raycaster, intersects);
      }
    };

    Object.defineProperties( TextMesh.prototype, prototypeAccessors );

    return TextMesh;
  }(three.Mesh));


  // Create setters for properties that affect text layout:
  var SYNCABLE_PROPS = [
    'font',
    'fontSize',
    'letterSpacing',
    'lineHeight',
    'maxWidth',
    'overflowWrap',
    'text',
    'textAlign',
    'whiteSpace',
    'anchor'
  ];
  SYNCABLE_PROPS.forEach(function (prop) {
    var privateKey = '_private_' + prop;
    Object.defineProperty(TextMesh.prototype, prop, {
      get: function() {
        return this[privateKey]
      },
      set: prop === 'anchor'
        ? function(value) {
          if (JSON.stringify(value) !== JSON.stringify(this[privateKey])) {
            this[privateKey] = value;
            this._needsSync = true;
          }
        }
        : function(value) {
          if (value !== this[privateKey]) {
            this[privateKey] = value;
            this._needsSync = true;
          }
        }
    });
  });

  var COMPONENT_NAME = 'troika-text';


  aframe.registerComponent(COMPONENT_NAME, {
    schema: {
      align: {type: 'string', default: 'left', oneOf: ['left', 'right', 'center']},
      anchor: {default: 'center', oneOf: ['left', 'right', 'center', 'align']},
      baseline: {default: 'center', oneOf: ['top', 'center', 'bottom']},
      color: {type: 'color', default: '#FFF'},
      font: {type: 'string'},
      fontSize: {type: 'number', default: 0.2},
      letterSpacing: {type: 'number', default: 0},
      lineHeight: {type: 'number'},
      maxWidth: {type: 'number', default: Infinity},
      overflowWrap: {type: 'string', default: 'normal', oneOf: ['normal', 'break-word']},
      value: {type: 'string'},
      whiteSpace: {default: 'normal', oneOf: ['normal', 'nowrap']}

      // attrs that can be configured via troika-text-material:
      // opacity: {type: 'number', default: 1.0},
      // transparent: {default: true},
      // side: {default: 'front', oneOf: ['front', 'back', 'double']},
    },

    /**
     * Called once when component is attached. Generally for initial setup.
     */
    init: function () {
      // If we're being applied as a component attached to a generic a-entity, create an
      // anonymous sub-entity that we can use to isolate the text mesh and the material
      // component that should apply to it. If we're a primitive, no isolation is needed.
      var textEntity;
      var isPrimitive = this.el.tagName.toLowerCase() === 'a-troika-text';
      if (isPrimitive) {
        textEntity = this.el;
      } else {
        textEntity = document.createElement('a-entity');
        this.el.appendChild(textEntity);
      }
      this.troikaTextEntity = textEntity;

      // Create TextMesh and add it to the entity as the 'mesh' object
      var textMesh = this.troikaTextMesh = new TextMesh();
      textMesh.anchor = [0, 0];
      textEntity.setObject3D('mesh', textMesh);
    },

    /**
     * Called when component is attached and when component data changes.
     * Generally modifies the entity based on the data.
     */
    update: function () {
      var data = this.data;
      var mesh = this.troikaTextMesh;
      var entity = this.troikaTextEntity;

      // Update the text mesh
      mesh.text = data.value;
      mesh.textAlign = data.align;
      mesh.anchor[0] = anchorMapping[data.anchor];
      mesh.anchor[1] = baselineMapping[data.baseline];
      mesh.color = data.color;
      mesh.font = data.font; //TODO allow aframe stock font names
      mesh.fontSize = data.fontSize;
      mesh.letterSpacing = data.letterSpacing || 0;
      mesh.lineHeight = data.lineHeight || null;
      mesh.overflowWrap = data.overflowWrap;
      mesh.whiteSpace = data.whiteSpace;
      mesh.maxWidth = data.maxWidth;
      mesh.sync();

      // Pass material config down to child entity
      if (entity !== this.el) {
        var materialAttr = this.el.getAttribute('troika-text-material');
        if (materialAttr) {
          entity.setAttribute('material', materialAttr);
        } else {
          entity.removeAttribute('material');
        }
      }
    },

    /**
     * Called when a component is removed (e.g., via removeAttribute).
     * Generally undoes all modifications to the entity.
     */
    remove: function () {
      // Free memory
      this.troikaTextMesh.dispose();

      // If using sub-entity, remove it
      if (this.troikaTextEntity !== this.el) {
        this.el.removeChild(this.troikaTextEntity);
      }
    }

  });


  var anchorMapping = {
    'left': 0,
    'center': 0.5,
    'right': 1
  };
  var baselineMapping = {
    'top': 0,
    'center': 0.5,
    'bottom': 1
  };

  var mappings = {};

  // From aframe's primitives.js utilities...
  var schema = aframe.components[COMPONENT_NAME].schema;
  Object.keys(schema).map(function (prop) {
    // Hyphenate where there is camelCase.
    var attrName = prop.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    mappings[attrName] = COMPONENT_NAME + '.' + prop;
  });


  aframe.registerPrimitive('a-troika-text', {
    defaultComponents: {
      'troika-text': {}
    },
    mappings: mappings
  });

}(AFRAME, THREE));
