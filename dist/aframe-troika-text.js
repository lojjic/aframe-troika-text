(function (THREE, aframe) {
  'use strict';

  function _interopDefaultLegacy (e) { return e && typeof e === 'object' && 'default' in e ? e : { 'default': e }; }

  function _interopNamespace(e) {
    if (e && e.__esModule) return e;
    var n = Object.create(null);
    if (e) {
      Object.keys(e).forEach(function (k) {
        if (k !== 'default') {
          var d = Object.getOwnPropertyDescriptor(e, k);
          Object.defineProperty(n, k, d.get ? d : {
            enumerable: true,
            get: function () {
              return e[k];
            }
          });
        }
      });
    }
    n['default'] = e;
    return Object.freeze(n);
  }

  var THREE__namespace = /*#__PURE__*/_interopNamespace(THREE);
  var aframe__default = /*#__PURE__*/_interopDefaultLegacy(aframe);

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
   * Promise.all() impl:
   */
  BespokeThenable.all = NativePromiseThenable.all = function(items) {
    var resultCount = 0;
    var results = [];
    var out = DefaultThenable();
    if (items.length === 0) {
      out.resolve([]);
    } else {
      items.forEach(function (item, i) {
        var itemThenable = DefaultThenable();
        itemThenable.resolve(item);
        itemThenable.then(function (res) {
          resultCount++;
          results[i] = res;
          if (resultCount === items.length) {
            out.resolve(results);
          }
        }, out.reject);
      });
    }
    return out
  };


  /**
   * Choose the best Thenable implementation and export it as the default.
   */
  var DefaultThenable = typeof Promise === 'function' ? NativePromiseThenable : BespokeThenable;

  /**
   * Main content for the worker that handles the loading and execution of
   * modules within it.
   */
  function workerBootstrap() {
    var modules = Object.create(null);

    // Handle messages for registering a module
    function registerModule(ref, callback) {
      var id = ref.id;
      var name = ref.name;
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
        init = rehydrate(("<" + name + ">.init"), init);
        if (getTransferables) {
          getTransferables = rehydrate(("<" + name + ">.getTransferables"), getTransferables);
        }

        // Initialize the module and store its value
        var value = null;
        if (typeof init === 'function') {
          value = init.apply(void 0, dependencies);
        } else {
          console.error('worker module init function failed to rehydrate');
        }
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

    function rehydrate(name, str) {
      var result = void 0;
      self.troikaDefine = function (r) { return result = r; };
      var url = URL.createObjectURL(
        new Blob(
          [("/** " + (name.replace(/\*/g, '')) + " **/\n\ntroikaDefine(\n" + str + "\n)")],
          {type: 'application/javascript'}
        )
      );
      try {
        importScripts(url);
      } catch(err) {
        console.error(err);
      }
      URL.revokeObjectURL(url);
      delete self.troikaDefine;
      return result
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
  }

  /**
   * Fallback for `defineWorkerModule` that behaves identically but runs in the main
   * thread, for when the execution environment doesn't support web workers or they
   * are disallowed due to e.g. CSP security restrictions.
   */
  function defineMainThreadModule(options) {
    var moduleFunc = function() {
      var args = [], len = arguments.length;
      while ( len-- ) args[ len ] = arguments[ len ];

      return moduleFunc._getInitResult().then(function (initResult) {
        if (typeof initResult === 'function') {
          return initResult.apply(void 0, args)
        } else {
          throw new Error('Worker module function was called but `init` did not return a callable function')
        }
      })
    };
    moduleFunc._getInitResult = function() {
      // We can ignore getTransferables in main thread. TODO workerId?
      var dependencies = options.dependencies;
      var init = options.init;

      // Resolve dependencies
      dependencies = Array.isArray(dependencies) ? dependencies.map(function (dep) { return dep && dep._getInitResult ? dep._getInitResult() : dep; }
      ) : [];

      // Invoke init with the resolved dependencies
      var initThenable = DefaultThenable.all(dependencies).then(function (deps) {
        return init.apply(null, deps)
      });

      // Cache the resolved promise for subsequent calls
      moduleFunc._getInitResult = function () { return initThenable; };

      return initThenable
    };
    return moduleFunc
  }

  var supportsWorkers = function () {
    var supported = false;

    // Only attempt worker initialization in browsers; elsewhere it would just be
    // noise e.g. loading into a Node environment for SSR.
    if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
      try {
        // TODO additional checks for things like importScripts within the worker?
        //  Would need to be an async check.
        var worker = new Worker(
          URL.createObjectURL(new Blob([''], { type: 'application/javascript' }))
        );
        worker.terminate();
        supported = true;
      } catch (err) {
        if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') ; else {
          console.log(
            ("Troika createWorkerModule: web workers not allowed; falling back to main thread execution. Cause: [" + (err.message) + "]")
          );
        }
      }
    }

    // Cached result
    supportsWorkers = function () { return supported; };
    return supported
  };

  var _workerModuleId = 0;
  var _messageId = 0;
  var _allowInitAsString = false;
  var workers = Object.create(null);
  var openRequests = /*#__PURE__*/(function () {
    var obj = Object.create(null);
    obj._count = 0;
    return obj
  })();


  /**
   * Define a module of code that will be executed with a web worker. This provides a simple
   * interface for moving chunks of logic off the main thread, and managing their dependencies
   * among one another.
   *
   * @param {object} options
   * @param {function} options.init
   * @param {array} [options.dependencies]
   * @param {function} [options.getTransferables]
   * @param {string} [options.name]
   * @param {string} [options.workerId]
   * @return {function(...[*]): {then}}
   */
  function defineWorkerModule(options) {
    if ((!options || typeof options.init !== 'function') && !_allowInitAsString) {
      throw new Error('requires `options.init` function')
    }
    var dependencies = options.dependencies;
    var init = options.init;
    var getTransferables = options.getTransferables;
    var workerId = options.workerId;

    if (!supportsWorkers()) {
      return defineMainThreadModule(options)
    }

    if (workerId == null) {
      workerId = '#default';
    }
    var id = "workerModule" + (++_workerModuleId);
    var name = options.name || id;
    var registrationThenable = null;

    dependencies = dependencies && dependencies.map(function (dep) {
      // Wrap raw functions as worker modules with no dependencies
      if (typeof dep === 'function' && !dep.workerModuleData) {
        _allowInitAsString = true;
        dep = defineWorkerModule({
          workerId: workerId,
          name: ("<" + name + "> function dependency: " + (dep.name)),
          init: ("function(){return (\n" + (stringifyFunction(dep)) + "\n)}")
        });
        _allowInitAsString = false;
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
        registrationThenable = callWorker(workerId,'registerModule', moduleFunc.workerModuleData);
      }

      // Invoke the module, returning a thenable
      return registrationThenable.then(function (ref) {
        var isCallable = ref.isCallable;

        if (isCallable) {
          return callWorker(workerId,'callModule', {id: id, args: args})
        } else {
          throw new Error('Worker module function was called but `init` did not return a callable function')
        }
      })
    }
    moduleFunc.workerModuleData = {
      isWorkerModule: true,
      id: id,
      name: name,
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


  function getWorker(workerId) {
    var worker = workers[workerId];
    if (!worker) {
      // Bootstrap the worker's content
      var bootstrap = stringifyFunction(workerBootstrap);

      // Create the worker from the bootstrap function content
      worker = workers[workerId] = new Worker(
        URL.createObjectURL(
          new Blob(
            [("/** Worker Module Bootstrap: " + (workerId.replace(/\*/g, '')) + " **/\n\n;(" + bootstrap + ")()")],
            {type: 'application/javascript'}
          )
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
        openRequests._count--;
        callback(response);
      };
    }
    return worker
  }

  // Issue a call to the worker with a callback to handle the response
  function callWorker(workerId, action, data) {
    var thenable = DefaultThenable();
    var messageId = ++_messageId;
    openRequests[messageId] = function (response) {
      if (response.success) {
        thenable.resolve(response.result);
      } else {
        thenable.reject(new Error(("Error in worker " + action + " call: " + (response.error))));
      }
    };
    openRequests._count++;
    if (openRequests._count > 1000) { //detect leaks
      console.warn('Large number of open WorkerModule requests, some may not be returning');
    }
    getWorker(workerId).postMessage({
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
  var ThenableWorkerModule = /*#__PURE__*/defineWorkerModule({
    name: 'Thenable',
    dependencies: [DefaultThenable],
    init: function(Thenable) {
      return Thenable
    }
  });

  function bidiFactory() {
  var bidi = (function (exports) {

    // Bidi character types data, auto generated
    var DATA = {
      "R": "13k,1a,2,3,3,2+1j,ch+16,a+1,5+2,2+n,5,a,4,6+16,4+3,h+1b,4mo,179q,2+9,2+11,2i9+7y,2+68,4,3+4,5+13,4+3,2+4k,3+29,8+cf,1t+7z,w+17,3+3m,1t+3z,16o1+5r,8+30,8+mc,29+1r,29+4v,75+73",
      "EN": "1c+9,3d+1,6,187+9,513,4+5,7+9,sf+j,175h+9,qw+q,161f+1d,4xt+a,25i+9",
      "ES": "17,2,6dp+1,f+1,av,16vr,mx+1,4o,2",
      "ET": "z+2,3h+3,b+1,ym,3e+1,2o,p4+1,8,6u,7c,g6,1wc,1n9+4,30+1b,2n,6d,qhx+1,h0m,a+1,49+2,63+1,4+1,6bb+3,12jj",
      "AN": "16o+5,2j+9,2+1,35,ed,1ff2+9,87+u",
      "CS": "18,2+1,b,2u,12k,55v,l,17v0,2,3,53,2+1,b",
      "B": "a,3,f+2,2v,690",
      "S": "9,2,k",
      "WS": "c,k,4f4,1vk+a,u,1j,335",
      "ON": "x+1,4+4,h+5,r+5,r+3,z,5+3,2+1,2+1,5,2+2,3+4,o,w,ci+1,8+d,3+d,6+8,2+g,39+1,9,6+1,2,33,b8,3+1,3c+1,7+1,5r,b,7h+3,sa+5,2,3i+6,jg+3,ur+9,2v,ij+1,9g+9,7+a,8m,4+1,49+x,14u,2+2,c+2,e+2,e+2,e+1,i+n,e+e,2+p,u+2,e+2,36+1,2+3,2+1,b,2+2,6+5,2,2,2,h+1,5+4,6+3,3+f,16+2,5+3l,3+81,1y+p,2+40,q+a,m+13,2r+ch,2+9e,75+hf,3+v,2+2w,6e+5,f+6,75+2a,1a+p,2+2g,d+5x,r+b,6+3,4+o,g,6+1,6+2,2k+1,4,2j,5h+z,1m+1,1e+f,t+2,1f+e,d+3,4o+3,2s+1,w,535+1r,h3l+1i,93+2,2s,b+1,3l+x,2v,4g+3,21+3,kz+1,g5v+1,5a,j+9,n+v,2,3,2+8,2+1,3+2,2,3,46+1,4+4,h+5,r+5,r+a,3h+2,4+6,b+4,78,1r+24,4+c,4,1hb,ey+6,103+j,16j+c,1ux+7,5+g,fsh,jdq+1t,4,57+2e,p1,1m,1m,1m,1m,4kt+1,7j+17,5+2r,d+e,3+e,2+e,2+10,m+4,w,1n+5,1q,4z+5,4b+rb,9+c,4+c,4+37,d+2g,8+b,l+b,5+1j,9+9,7+13,9+t,3+1,27+3c,2+29,2+3q,d+d,3+4,4+2,6+6,a+o,8+6,a+2,e+6,16+42,2+1i",
      "BN": "0+8,6+d,2s+5,2+p,e,4m9,1kt+2,2b+5,5+5,17q9+v,7k,6p+8,6+1,119d+3,440+7,96s+1,1ekf+1,1ekf+1,1ekf+1,1ekf+1,1ekf+1,1ekf+1,1ekf+1,1ekf+1,1ekf+1,1ekf+1,1ekf+1,1ekf+75,6p+2rz,1ben+1,1ekf+1,1ekf+1",
      "NSM": "lc+33,7o+6,7c+18,2,2+1,2+1,2,21+a,1d+k,h,2u+6,3+5,3+1,2+3,10,v+q,2k+a,1n+8,a,p+3,2+8,2+2,2+4,18+2,3c+e,2+v,1k,2,5+7,5,4+6,b+1,u,1n,5+3,9,l+1,r,3+1,1m,5+1,5+1,3+2,4,v+1,4,c+1,1m,5+4,2+1,5,l+1,n+5,2,1n,3,2+3,9,8+1,c+1,v,1q,d,1f,4,1m+2,6+2,2+3,8+1,c+1,u,1n,g+1,l+1,t+1,1m+1,5+3,9,l+1,u,21,8+2,2,2j,3+6,d+7,2r,3+8,c+5,23+1,s,2,2,1k+d,2+4,2+1,6+a,2+z,a,2v+3,2+5,2+1,3+1,q+1,5+2,h+3,e,3+1,7,g,jk+2,qb+2,u+2,u+1,v+1,1t+1,2+6,9,3+a,a,1a+2,3c+1,z,3b+2,5+1,a,7+2,64+1,3,1n,2+6,2,2,3+7,7+9,3,1d+g,1s+3,1d,2+4,2,6,15+8,d+1,x+3,3+1,2+2,1l,2+1,4,2+2,1n+7,3+1,49+2,2+c,2+6,5,7,4+1,5j+1l,2+4,k1+w,2db+2,3y,2p+v,ff+3,30+1,n9x+3,2+9,x+1,29+1,7l,4,5,q+1,6,48+1,r+h,e,13+7,q+a,1b+2,1d,3+3,3+1,14,1w+5,3+1,3+1,d,9,1c,1g,2+2,3+1,6+1,2,17+1,9,6n,3,5,fn5,ki+f,h+f,r2,6b,46+4,1af+2,2+1,6+3,15+2,5,4m+1,fy+3,as+1,4a+a,4x,1j+e,1l+2,1e+3,3+1,1y+2,11+4,2+7,1r,d+1,1h+8,b+3,3,2o+2,3,2+1,7,4h,4+7,m+1,1m+1,4,12+6,4+4,5g+7,3+2,2,o,2d+5,2,5+1,2+1,6n+3,7+1,2+1,s+1,2e+7,3,2+1,2z,2,3+5,2,2u+2,3+3,2+4,78+8,2+1,75+1,2,5,41+3,3+1,5,x+5,3+1,15+5,3+3,9,a+5,3+2,1b+c,2+1,bb+6,2+5,2d+l,3+6,2+1,2+1,3f+5,4,2+1,2+6,2,21+1,4,2,9o+1,f0c+4,1o+6,t5,1s+3,2a,f5l+1,43t+2,i+7,3+6,v+3,45+2,1j0+1i,5+1d,9,f,n+4,2+e,11t+6,2+g,3+6,2+1,2+4,7a+6,c6+3,15t+6,32+6,gzhy+6n",
      "AL": "16w,3,2,e+1b,z+2,2+2s,g+1,8+1,b+m,2+t,s+2i,c+e,4h+f,1d+1e,1bwe+dp,3+3z,x+c,2+1,35+3y,2rm+z,5+7,b+5,dt+l,c+u,17nl+27,1t+27,4x+6n,3+d",
      "LRO": "6ct",
      "RLO": "6cu",
      "LRE": "6cq",
      "RLE": "6cr",
      "PDF": "6cs",
      "LRI": "6ee",
      "RLI": "6ef",
      "FSI": "6eg",
      "PDI": "6eh"
    };

    const TYPES = {};
    const TYPES_TO_NAMES = {};
    TYPES.L = 1; //L is the default
    TYPES_TO_NAMES[1] = 'L';
    Object.keys(DATA).forEach((type, i) => {
      TYPES[type] = 1 << (i + 1);
      TYPES_TO_NAMES[TYPES[type]] = type;
    });
    Object.freeze(TYPES);

    const ISOLATE_INIT_TYPES = TYPES.LRI | TYPES.RLI | TYPES.FSI;
    const STRONG_TYPES = TYPES.L | TYPES.R | TYPES.AL;
    const NEUTRAL_ISOLATE_TYPES = TYPES.B | TYPES.S | TYPES.WS | TYPES.ON | TYPES.FSI | TYPES.LRI | TYPES.RLI | TYPES.PDI;
    const BN_LIKE_TYPES = TYPES.BN | TYPES.RLE | TYPES.LRE | TYPES.RLO | TYPES.LRO | TYPES.PDF;
    const TRAILING_TYPES = TYPES.S | TYPES.WS | TYPES.B | ISOLATE_INIT_TYPES | TYPES.PDI | BN_LIKE_TYPES;

    let map = null;

    function parseData () {
      if (!map) {
        //const start = performance.now()
        map = new Map();
        for (let type in DATA) {
          if (DATA.hasOwnProperty(type)) {
            let lastCode = 0;
            DATA[type].split(',').forEach(range => {
              let [skip, step] = range.split('+');
              skip = parseInt(skip, 36);
              step = step ? parseInt(step, 36) : 0;
              map.set(lastCode += skip, TYPES[type]);
              for (let i = 0; i < step; i++) {
                map.set(++lastCode, TYPES[type]);
              }
            });
          }
        }
        //console.log(`char types parsed in ${performance.now() - start}ms`)
      }
    }

    /**
     * @param {string} char
     * @return {number}
     */
    function getBidiCharType (char) {
      parseData();
      return map.get(char.codePointAt(0)) || TYPES.L
    }

    function getBidiCharTypeName(char) {
      return TYPES_TO_NAMES[getBidiCharType(char)]
    }

    // Bidi bracket pairs data, auto generated
    var data$1 = {
      "pairs": "14>1,1e>2,u>2,2wt>1,1>1,1ge>1,1wp>1,1j>1,f>1,hm>1,1>1,u>1,u6>1,1>1,+5,28>1,w>1,1>1,+3,b8>1,1>1,+3,1>3,-1>-1,3>1,1>1,+2,1s>1,1>1,x>1,th>1,1>1,+2,db>1,1>1,+3,3>1,1>1,+2,14qm>1,1>1,+1,4q>1,1e>2,u>2,2>1,+1",
      "canonical": "6f1>-6dx,6dy>-6dx,6ec>-6ed,6ee>-6ed,6ww>2jj,-2ji>2jj,14r4>-1e7l,1e7m>-1e7l,1e7m>-1e5c,1e5d>-1e5b,1e5c>-14qx,14qy>-14qx,14vn>-1ecg,1ech>-1ecg,1edu>-1ecg,1eci>-1ecg,1eda>-1ecg,1eci>-1ecg,1eci>-168q,168r>-168q,168s>-14ye,14yf>-14ye"
    };

    /**
     * Parses an string that holds encoded codepoint mappings, e.g. for bracket pairs or
     * mirroring characters, as encoded by scripts/generateBidiData.js. Returns an object
     * holding the `map`, and optionally a `reverseMap` if `includeReverse:true`.
     * @param {string} encodedString
     * @param {boolean} includeReverse - true if you want reverseMap in the output
     * @return {{map: Map<number, number>, reverseMap?: Map<number, number>}}
     */
    function parseCharacterMap (encodedString, includeReverse) {
      const radix = 36;
      let lastCode = 0;
      const map = new Map();
      const reverseMap = includeReverse && new Map();
      let prevPair;
      encodedString.split(',').forEach(function visit(entry) {
        if (entry.indexOf('+') !== -1) {
          for (let i = +entry; i--;) {
            visit(prevPair);
          }
        } else {
          prevPair = entry;
          let [a, b] = entry.split('>');
          a = String.fromCodePoint(lastCode += parseInt(a, radix));
          b = String.fromCodePoint(lastCode += parseInt(b, radix));
          map.set(a, b);
          includeReverse && reverseMap.set(b, a);
        }
      });
      return { map, reverseMap }
    }

    let openToClose, closeToOpen, canonical;

    function parse$1 () {
      if (!openToClose) {
        //const start = performance.now()
        let { map, reverseMap } = parseCharacterMap(data$1.pairs, true);
        openToClose = map;
        closeToOpen = reverseMap;
        canonical = parseCharacterMap(data$1.canonical, false).map;
        //console.log(`brackets parsed in ${performance.now() - start}ms`)
      }
    }

    function openingToClosingBracket (char) {
      parse$1();
      return openToClose.get(char) || null
    }

    function closingToOpeningBracket (char) {
      parse$1();
      return closeToOpen.get(char) || null
    }

    function getCanonicalBracket (char) {
      parse$1();
      return canonical.get(char) || null
    }

    // Local type aliases
    const {
      L: TYPE_L,
      R: TYPE_R,
      EN: TYPE_EN,
      ES: TYPE_ES,
      ET: TYPE_ET,
      AN: TYPE_AN,
      CS: TYPE_CS,
      B: TYPE_B,
      S: TYPE_S,
      ON: TYPE_ON,
      BN: TYPE_BN,
      NSM: TYPE_NSM,
      AL: TYPE_AL,
      LRO: TYPE_LRO,
      RLO: TYPE_RLO,
      LRE: TYPE_LRE,
      RLE: TYPE_RLE,
      PDF: TYPE_PDF,
      LRI: TYPE_LRI,
      RLI: TYPE_RLI,
      FSI: TYPE_FSI,
      PDI: TYPE_PDI
    } = TYPES;

    /**
     * @typedef {object} GetEmbeddingLevelsResult
     * @property {{start, end, level}[]} paragraphs
     * @property {Uint8Array} levels
     */

    /**
     * This function applies the Bidirectional Algorithm to a string, returning the resolved embedding levels
     * in a single Uint8Array plus a list of objects holding each paragraph's start and end indices and resolved
     * base embedding level.
     *
     * @param {string} string - The input string
     * @param {"ltr"|"rtl"|"auto"} [baseDirection] - Use "ltr" or "rtl" to force a base paragraph direction,
     *        otherwise a direction will be chosen automatically from each paragraph's contents.
     * @return {GetEmbeddingLevelsResult}
     */
    function getEmbeddingLevels (string, baseDirection) {
      const MAX_DEPTH = 125;

      // Start by mapping all characters to their unicode type, as a bitmask integer
      const charTypes = new Uint32Array(string.length);
      for (let i = 0; i < string.length; i++) {
        charTypes[i] = getBidiCharType(string[i]);
      }

      const charTypeCounts = new Map(); //will be cleared at start of each paragraph
      function changeCharType(i, type) {
        const oldType = charTypes[i];
        charTypes[i] = type;
        charTypeCounts.set(oldType, charTypeCounts.get(oldType) - 1);
        if (oldType & NEUTRAL_ISOLATE_TYPES) {
          charTypeCounts.set(NEUTRAL_ISOLATE_TYPES, charTypeCounts.get(NEUTRAL_ISOLATE_TYPES) - 1);
        }
        charTypeCounts.set(type, (charTypeCounts.get(type) || 0) + 1);
        if (type & NEUTRAL_ISOLATE_TYPES) {
          charTypeCounts.set(NEUTRAL_ISOLATE_TYPES, (charTypeCounts.get(NEUTRAL_ISOLATE_TYPES) || 0) + 1);
        }
      }

      const embedLevels = new Uint8Array(string.length);
      const isolationPairs = new Map(); //init->pdi and pdi->init

      // === 3.3.1 The Paragraph Level ===
      // 3.3.1 P1: Split the text into paragraphs
      const paragraphs = []; // [{start, end, level}, ...]
      let paragraph = null;
      for (let i = 0; i < string.length; i++) {
        if (!paragraph) {
          paragraphs.push(paragraph = {
            start: i,
            end: string.length - 1,
            // 3.3.1 P2-P3: Determine the paragraph level
            level: baseDirection === 'rtl' ? 1 : baseDirection === 'ltr' ? 0 : determineAutoEmbedLevel(i, false)
          });
        }
        if (charTypes[i] & TYPE_B) {
          paragraph.end = i;
          paragraph = null;
        }
      }

      const FORMATTING_TYPES = TYPE_RLE | TYPE_LRE | TYPE_RLO | TYPE_LRO | ISOLATE_INIT_TYPES | TYPE_PDI | TYPE_PDF | TYPE_B;
      const nextEven = n => n + ((n & 1) ? 1 : 2);
      const nextOdd = n => n + ((n & 1) ? 2 : 1);

      // Everything from here on will operate per paragraph.
      for (let paraIdx = 0; paraIdx < paragraphs.length; paraIdx++) {
        paragraph = paragraphs[paraIdx];
        const statusStack = [{
          _level: paragraph.level,
          _override: 0, //0=neutral, 1=L, 2=R
          _isolate: 0 //bool
        }];
        let stackTop;
        let overflowIsolateCount = 0;
        let overflowEmbeddingCount = 0;
        let validIsolateCount = 0;
        charTypeCounts.clear();

        // === 3.3.2 Explicit Levels and Directions ===
        for (let i = paragraph.start; i <= paragraph.end; i++) {
          let charType = charTypes[i];
          stackTop = statusStack[statusStack.length - 1];

          // Set initial counts
          charTypeCounts.set(charType, (charTypeCounts.get(charType) || 0) + 1);
          if (charType & NEUTRAL_ISOLATE_TYPES) {
            charTypeCounts.set(NEUTRAL_ISOLATE_TYPES, (charTypeCounts.get(NEUTRAL_ISOLATE_TYPES) || 0) + 1);
          }

          // Explicit Embeddings: 3.3.2 X2 - X3
          if (charType & FORMATTING_TYPES) { //prefilter all formatters
            if (charType & (TYPE_RLE | TYPE_LRE)) {
              embedLevels[i] = stackTop._level; // 5.2
              const level = (charType === TYPE_RLE ? nextOdd : nextEven)(stackTop._level);
              if (level <= MAX_DEPTH && !overflowIsolateCount && !overflowEmbeddingCount) {
                statusStack.push({
                  _level: level,
                  _override: 0,
                  _isolate: 0
                });
              } else if (!overflowIsolateCount) {
                overflowEmbeddingCount++;
              }
            }

            // Explicit Overrides: 3.3.2 X4 - X5
            else if (charType & (TYPE_RLO | TYPE_LRO)) {
              embedLevels[i] = stackTop._level; // 5.2
              const level = (charType === TYPE_RLO ? nextOdd : nextEven)(stackTop._level);
              if (level <= MAX_DEPTH && !overflowIsolateCount && !overflowEmbeddingCount) {
                statusStack.push({
                  _level: level,
                  _override: (charType & TYPE_RLO) ? TYPE_R : TYPE_L,
                  _isolate: 0
                });
              } else if (!overflowIsolateCount) {
                overflowEmbeddingCount++;
              }
            }

            // Isolates: 3.3.2 X5a - X5c
            else if (charType & ISOLATE_INIT_TYPES) {
              // X5c - FSI becomes either RLI or LRI
              if (charType & TYPE_FSI) {
                charType = determineAutoEmbedLevel(i + 1, true) === 1 ? TYPE_RLI : TYPE_LRI;
              }

              embedLevels[i] = stackTop._level;
              if (stackTop._override) {
                changeCharType(i, stackTop._override);
              }
              const level = (charType === TYPE_RLI ? nextOdd : nextEven)(stackTop._level);
              if (level <= MAX_DEPTH && overflowIsolateCount === 0 && overflowEmbeddingCount === 0) {
                validIsolateCount++;
                statusStack.push({
                  _level: level,
                  _override: 0,
                  _isolate: 1,
                  _isolInitIndex: i
                });
              } else {
                overflowIsolateCount++;
              }
            }

            // Terminating Isolates: 3.3.2 X6a
            else if (charType & TYPE_PDI) {
              if (overflowIsolateCount > 0) {
                overflowIsolateCount--;
              } else if (validIsolateCount > 0) {
                overflowEmbeddingCount = 0;
                while (!statusStack[statusStack.length - 1]._isolate) {
                  statusStack.pop();
                }
                // Add to isolation pairs bidirectional mapping:
                const isolInitIndex = statusStack[statusStack.length - 1]._isolInitIndex;
                if (isolInitIndex != null) {
                  isolationPairs.set(isolInitIndex, i);
                  isolationPairs.set(i, isolInitIndex);
                }
                statusStack.pop();
                validIsolateCount--;
              }
              stackTop = statusStack[statusStack.length - 1];
              embedLevels[i] = stackTop._level;
              if (stackTop._override) {
                changeCharType(i, stackTop._override);
              }
            }


            // Terminating Embeddings and Overrides: 3.3.2 X7
            else if (charType & TYPE_PDF) {
              if (overflowIsolateCount === 0) {
                if (overflowEmbeddingCount > 0) {
                  overflowEmbeddingCount--;
                } else if (!stackTop._isolate && statusStack.length > 1) {
                  statusStack.pop();
                  stackTop = statusStack[statusStack.length - 1];
                }
              }
              embedLevels[i] = stackTop._level; // 5.2
            }

            // End of Paragraph: 3.3.2 X8
            else if (charType & TYPE_B) {
              embedLevels[i] = paragraph.level;
            }
          }

          // Non-formatting characters: 3.3.2 X6
          else {
            embedLevels[i] = stackTop._level;
            // NOTE: This exclusion of BN seems to go against what section 5.2 says, but is required for test passage
            if (stackTop._override && charType !== TYPE_BN) {
              changeCharType(i, stackTop._override);
            }
          }
        }

        // === 3.3.3 Preparations for Implicit Processing ===

        // Remove all RLE, LRE, RLO, LRO, PDF, and BN characters: 3.3.3 X9
        // Note: Due to section 5.2, we won't remove them, but we'll use the BN_LIKE_TYPES bitset to
        // easily ignore them all from here on out.

        // 3.3.3 X10
        // Compute the set of isolating run sequences as specified by BD13
        const levelRuns = [];
        let currentRun = null;
        for (let i = paragraph.start; i <= paragraph.end; i++) {
          const charType = charTypes[i];
          if (!(charType & BN_LIKE_TYPES)) {
            const lvl = embedLevels[i];
            const isIsolInit = charType & ISOLATE_INIT_TYPES;
            const isPDI = charType === TYPE_PDI;
            if (currentRun && lvl === currentRun._level) {
              currentRun._end = i;
              currentRun._endsWithIsolInit = isIsolInit;
            } else {
              levelRuns.push(currentRun = {
                _start: i,
                _end: i,
                _level: lvl,
                _startsWithPDI: isPDI,
                _endsWithIsolInit: isIsolInit
              });
            }
          }
        }
        const isolatingRunSeqs = []; // [{seqIndices: [], sosType: L|R, eosType: L|R}]
        for (let runIdx = 0; runIdx < levelRuns.length; runIdx++) {
          const run = levelRuns[runIdx];
          if (!run._startsWithPDI || (run._startsWithPDI && !isolationPairs.has(run._start))) {
            const seqRuns = [currentRun = run];
            for (let pdiIndex; currentRun && currentRun._endsWithIsolInit && (pdiIndex = isolationPairs.get(currentRun._end)) != null;) {
              for (let i = runIdx + 1; i < levelRuns.length; i++) {
                if (levelRuns[i]._start === pdiIndex) {
                  seqRuns.push(currentRun = levelRuns[i]);
                  break
                }
              }
            }
            // build flat list of indices across all runs:
            const seqIndices = [];
            for (let i = 0; i < seqRuns.length; i++) {
              const run = seqRuns[i];
              for (let j = run._start; j <= run._end; j++) {
                seqIndices.push(j);
              }
            }
            // determine the sos/eos types:
            let firstLevel = embedLevels[seqIndices[0]];
            let prevLevel = paragraph.level;
            for (let i = seqIndices[0] - 1; i >= 0; i--) {
              if (!(charTypes[i] & BN_LIKE_TYPES)) { //5.2
                prevLevel = embedLevels[i];
                break
              }
            }
            const lastIndex = seqIndices[seqIndices.length - 1];
            let lastLevel = embedLevels[lastIndex];
            let nextLevel = paragraph.level;
            if (!(charTypes[lastIndex] & ISOLATE_INIT_TYPES)) {
              for (let i = lastIndex + 1; i <= paragraph.end; i++) {
                if (!(charTypes[i] & BN_LIKE_TYPES)) { //5.2
                  nextLevel = embedLevels[i];
                  break
                }
              }
            }
            isolatingRunSeqs.push({
              _seqIndices: seqIndices,
              _sosType: Math.max(prevLevel, firstLevel) % 2 ? TYPE_R : TYPE_L,
              _eosType: Math.max(nextLevel, lastLevel) % 2 ? TYPE_R : TYPE_L
            });
          }
        }

        // The next steps are done per isolating run sequence
        for (let seqIdx = 0; seqIdx < isolatingRunSeqs.length; seqIdx++) {
          const { _seqIndices: seqIndices, _sosType: sosType, _eosType: eosType } = isolatingRunSeqs[seqIdx];

          // === 3.3.4 Resolving Weak Types ===

          // W1 + 5.2. Search backward from each NSM to the first character in the isolating run sequence whose
          // bidirectional type is not BN, and set the NSM to ON if it is an isolate initiator or PDI, and to its
          // type otherwise. If the NSM is the first non-BN character, change the NSM to the type of sos.
          if (charTypeCounts.get(TYPE_NSM)) {
            for (let si = 0; si < seqIndices.length; si++) {
              const i = seqIndices[si];
              if (charTypes[i] & TYPE_NSM) {
                let prevType = sosType;
                for (let sj = si - 1; sj >= 0; sj--) {
                  if (!(charTypes[seqIndices[sj]] & BN_LIKE_TYPES)) { //5.2 scan back to first non-BN
                    prevType = charTypes[seqIndices[sj]];
                    break
                  }
                }
                changeCharType(i, (prevType & (ISOLATE_INIT_TYPES | TYPE_PDI)) ? TYPE_ON : prevType);
              }
            }
          }

          // W2. Search backward from each instance of a European number until the first strong type (R, L, AL, or sos)
          // is found. If an AL is found, change the type of the European number to Arabic number.
          if (charTypeCounts.get(TYPE_EN)) {
            for (let si = 0; si < seqIndices.length; si++) {
              const i = seqIndices[si];
              if (charTypes[i] & TYPE_EN) {
                for (let sj = si - 1; sj >= -1; sj--) {
                  const prevCharType = sj === -1 ? sosType : charTypes[seqIndices[sj]];
                  if (prevCharType & STRONG_TYPES) {
                    if (prevCharType === TYPE_AL) {
                      changeCharType(i, TYPE_AN);
                    }
                    break
                  }
                }
              }
            }
          }

          // W3. Change all ALs to R
          if (charTypeCounts.get(TYPE_AL)) {
            for (let si = 0; si < seqIndices.length; si++) {
              const i = seqIndices[si];
              if (charTypes[i] & TYPE_AL) {
                changeCharType(i, TYPE_R);
              }
            }
          }

          // W4. A single European separator between two European numbers changes to a European number. A single common
          // separator between two numbers of the same type changes to that type.
          if (charTypeCounts.get(TYPE_ES) || charTypeCounts.get(TYPE_CS)) {
            for (let si = 1; si < seqIndices.length - 1; si++) {
              const i = seqIndices[si];
              if (charTypes[i] & (TYPE_ES | TYPE_CS)) {
                let prevType = 0, nextType = 0;
                for (let sj = si - 1; sj >= 0; sj--) {
                  prevType = charTypes[seqIndices[sj]];
                  if (!(prevType & BN_LIKE_TYPES)) { //5.2
                    break
                  }
                }
                for (let sj = si + 1; sj < seqIndices.length; sj++) {
                  nextType = charTypes[seqIndices[sj]];
                  if (!(nextType & BN_LIKE_TYPES)) { //5.2
                    break
                  }
                }
                if (prevType === nextType && (charTypes[i] === TYPE_ES ? prevType === TYPE_EN : (prevType & (TYPE_EN | TYPE_AN)))) {
                  changeCharType(i, prevType);
                }
              }
            }
          }

          // W5. A sequence of European terminators adjacent to European numbers changes to all European numbers.
          if (charTypeCounts.get(TYPE_EN)) {
            for (let si = 0; si < seqIndices.length; si++) {
              const i = seqIndices[si];
              if (charTypes[i] & TYPE_EN) {
                for (let sj = si - 1; sj >= 0 && (charTypes[seqIndices[sj]] & (TYPE_ET | BN_LIKE_TYPES)); sj--) {
                  changeCharType(seqIndices[sj], TYPE_EN);
                }
                for (let sj = si + 1; sj < seqIndices.length && (charTypes[seqIndices[sj]] & (TYPE_ET | BN_LIKE_TYPES)); sj++) {
                  changeCharType(seqIndices[sj], TYPE_EN);
                }
              }
            }
          }

          // W6. Otherwise, separators and terminators change to Other Neutral.
          if (charTypeCounts.get(TYPE_ET) || charTypeCounts.get(TYPE_ES) || charTypeCounts.get(TYPE_CS)) {
            for (let si = 0; si < seqIndices.length; si++) {
              const i = seqIndices[si];
              if (charTypes[i] & (TYPE_ET | TYPE_ES | TYPE_CS)) {
                changeCharType(i, TYPE_ON);
                // 5.2 transform adjacent BNs too:
                for (let sj = si - 1; sj >= 0 && (charTypes[seqIndices[sj]] & BN_LIKE_TYPES); sj--) {
                  changeCharType(seqIndices[sj], TYPE_ON);
                }
                for (let sj = si + 1; sj < seqIndices.length && (charTypes[seqIndices[sj]] & BN_LIKE_TYPES); sj++) {
                  changeCharType(seqIndices[sj], TYPE_ON);
                }
              }
            }
          }

          // W7. Search backward from each instance of a European number until the first strong type (R, L, or sos)
          // is found. If an L is found, then change the type of the European number to L.
          // NOTE: implemented in single forward pass for efficiency
          if (charTypeCounts.get(TYPE_EN)) {
            for (let si = 0, prevStrongType = sosType; si < seqIndices.length; si++) {
              const i = seqIndices[si];
              const type = charTypes[i];
              if (type & TYPE_EN) {
                if (prevStrongType === TYPE_L) {
                  changeCharType(i, TYPE_L);
                }
              } else if (type & STRONG_TYPES) {
                prevStrongType = type;
              }
            }
          }

          // === 3.3.5 Resolving Neutral and Isolate Formatting Types ===

          if (charTypeCounts.get(NEUTRAL_ISOLATE_TYPES)) {
            // N0. Process bracket pairs in an isolating run sequence sequentially in the logical order of the text
            // positions of the opening paired brackets using the logic given below. Within this scope, bidirectional
            // types EN and AN are treated as R.
            const R_TYPES_FOR_N_STEPS = (TYPE_R | TYPE_EN | TYPE_AN);
            const STRONG_TYPES_FOR_N_STEPS = R_TYPES_FOR_N_STEPS | TYPE_L;

            // * Identify the bracket pairs in the current isolating run sequence according to BD16.
            const bracketPairs = [];
            {
              const openerStack = [];
              for (let si = 0; si < seqIndices.length; si++) {
                // NOTE: for any potential bracket character we also test that it still carries a NI
                // type, as that may have been changed earlier. This doesn't seem to be explicitly
                // called out in the spec, but is required for passage of certain tests.
                if (charTypes[seqIndices[si]] & NEUTRAL_ISOLATE_TYPES) {
                  const char = string[seqIndices[si]];
                  let oppositeBracket;
                  // Opening bracket
                  if (openingToClosingBracket(char) !== null) {
                    if (openerStack.length < 63) {
                      openerStack.push({ char, seqIndex: si });
                    } else {
                      break
                    }
                  }
                  // Closing bracket
                  else if ((oppositeBracket = closingToOpeningBracket(char)) !== null) {
                    for (let stackIdx = openerStack.length - 1; stackIdx >= 0; stackIdx--) {
                      const stackChar = openerStack[stackIdx].char;
                      if (stackChar === oppositeBracket ||
                        stackChar === closingToOpeningBracket(getCanonicalBracket(char)) ||
                        openingToClosingBracket(getCanonicalBracket(stackChar)) === char
                      ) {
                        bracketPairs.push([openerStack[stackIdx].seqIndex, si]);
                        openerStack.length = stackIdx; //pop the matching bracket and all following
                        break
                      }
                    }
                  }
                }
              }
              bracketPairs.sort((a, b) => a[0] - b[0]);
            }
            // * For each bracket-pair element in the list of pairs of text positions
            for (let pairIdx = 0; pairIdx < bracketPairs.length; pairIdx++) {
              const [openSeqIdx, closeSeqIdx] = bracketPairs[pairIdx];
              // a. Inspect the bidirectional types of the characters enclosed within the bracket pair.
              // b. If any strong type (either L or R) matching the embedding direction is found, set the type for both
              // brackets in the pair to match the embedding direction.
              let foundStrongType = false;
              let useStrongType = 0;
              for (let si = openSeqIdx + 1; si < closeSeqIdx; si++) {
                const i = seqIndices[si];
                if (charTypes[i] & STRONG_TYPES_FOR_N_STEPS) {
                  foundStrongType = true;
                  const lr = (charTypes[i] & R_TYPES_FOR_N_STEPS) ? TYPE_R : TYPE_L;
                  if (lr === getEmbedDirection(i)) {
                    useStrongType = lr;
                    break
                  }
                }
              }
              // c. Otherwise, if there is a strong type it must be opposite the embedding direction. Therefore, test
              // for an established context with a preceding strong type by checking backwards before the opening paired
              // bracket until the first strong type (L, R, or sos) is found.
              //    1. If the preceding strong type is also opposite the embedding direction, context is established, so
              //    set the type for both brackets in the pair to that direction.
              //    2. Otherwise set the type for both brackets in the pair to the embedding direction.
              if (foundStrongType && !useStrongType) {
                useStrongType = sosType;
                for (let si = openSeqIdx - 1; si >= 0; si--) {
                  const i = seqIndices[si];
                  if (charTypes[i] & STRONG_TYPES_FOR_N_STEPS) {
                    const lr = (charTypes[i] & R_TYPES_FOR_N_STEPS) ? TYPE_R : TYPE_L;
                    if (lr !== getEmbedDirection(i)) {
                      useStrongType = lr;
                    } else {
                      useStrongType = getEmbedDirection(i);
                    }
                    break
                  }
                }
              }
              if (useStrongType) {
                charTypes[seqIndices[openSeqIdx]] = charTypes[seqIndices[closeSeqIdx]] = useStrongType;
                // * Any number of characters that had original bidirectional character type NSM prior to the application
                // of W1 that immediately follow a paired bracket which changed to L or R under N0 should change to match
                // the type of their preceding bracket.
                if (useStrongType !== getEmbedDirection(seqIndices[openSeqIdx])) {
                  for (let si = openSeqIdx + 1; si < seqIndices.length; si++) {
                    if (!(charTypes[seqIndices[si]] & BN_LIKE_TYPES)) {
                      if (getBidiCharType(string[seqIndices[si]]) & TYPE_NSM) {
                        charTypes[seqIndices[si]] = useStrongType;
                      }
                      break
                    }
                  }
                }
                if (useStrongType !== getEmbedDirection(seqIndices[closeSeqIdx])) {
                  for (let si = closeSeqIdx + 1; si < seqIndices.length; si++) {
                    if (!(charTypes[seqIndices[si]] & BN_LIKE_TYPES)) {
                      if (getBidiCharType(string[seqIndices[si]]) & TYPE_NSM) {
                        charTypes[seqIndices[si]] = useStrongType;
                      }
                      break
                    }
                  }
                }
              }
            }

            // N1. A sequence of NIs takes the direction of the surrounding strong text if the text on both sides has the
            // same direction.
            // N2. Any remaining NIs take the embedding direction.
            for (let si = 0; si < seqIndices.length; si++) {
              if (charTypes[seqIndices[si]] & NEUTRAL_ISOLATE_TYPES) {
                let niRunStart = si, niRunEnd = si;
                let prevType = sosType; //si === 0 ? sosType : (charTypes[seqIndices[si - 1]] & R_TYPES_FOR_N_STEPS) ? TYPE_R : TYPE_L
                for (let si2 = si - 1; si2 >= 0; si2--) {
                  if (charTypes[seqIndices[si2]] & BN_LIKE_TYPES) {
                    niRunStart = si2; //5.2 treat BNs adjacent to NIs as NIs
                  } else {
                    prevType = (charTypes[seqIndices[si2]] & R_TYPES_FOR_N_STEPS) ? TYPE_R : TYPE_L;
                    break
                  }
                }
                let nextType = eosType;
                for (let si2 = si + 1; si2 < seqIndices.length; si2++) {
                  if (charTypes[seqIndices[si2]] & (NEUTRAL_ISOLATE_TYPES | BN_LIKE_TYPES)) {
                    niRunEnd = si2;
                  } else {
                    nextType = (charTypes[seqIndices[si2]] & R_TYPES_FOR_N_STEPS) ? TYPE_R : TYPE_L;
                    break
                  }
                }
                for (let sj = niRunStart; sj <= niRunEnd; sj++) {
                  charTypes[seqIndices[sj]] = prevType === nextType ? prevType : getEmbedDirection(seqIndices[sj]);
                }
                si = niRunEnd;
              }
            }
          }
        }

        // === 3.3.6 Resolving Implicit Levels ===

        for (let i = paragraph.start; i <= paragraph.end; i++) {
          const level = embedLevels[i];
          const type = charTypes[i];
          // I2. For all characters with an odd (right-to-left) embedding level, those of type L, EN or AN go up one level.
          if (level & 1) {
            if (type & (TYPE_L | TYPE_EN | TYPE_AN)) {
              embedLevels[i]++;
            }
          }
            // I1. For all characters with an even (left-to-right) embedding level, those of type R go up one level
          // and those of type AN or EN go up two levels.
          else {
            if (type & TYPE_R) {
              embedLevels[i]++;
            } else if (type & (TYPE_AN | TYPE_EN)) {
              embedLevels[i] += 2;
            }
          }

          // 5.2: Resolve any LRE, RLE, LRO, RLO, PDF, or BN to the level of the preceding character if there is one,
          // and otherwise to the base level.
          if (type & BN_LIKE_TYPES) {
            embedLevels[i] = i === 0 ? paragraph.level : embedLevels[i - 1];
          }

          // 3.4 L1.1-4: Reset the embedding level of segment/paragraph separators, and any sequence of whitespace or
          // isolate formatting characters preceding them or the end of the paragraph, to the paragraph level.
          // NOTE: this will also need to be applied to each individual line ending after line wrapping occurs.
          if (i === paragraph.end || getBidiCharType(string[i]) & (TYPE_S | TYPE_B)) {
            for (let j = i; j >= 0 && (getBidiCharType(string[j]) & TRAILING_TYPES); j--) {
              embedLevels[j] = paragraph.level;
            }
          }
        }
      }

      // DONE! The resolved levels can then be used, after line wrapping, to flip runs of characters
      // according to section 3.4 Reordering Resolved Levels
      return {
        levels: embedLevels,
        paragraphs
      }

      function determineAutoEmbedLevel (start, isFSI) {
        // 3.3.1 P2 - P3
        for (let i = start; i < string.length; i++) {
          const charType = charTypes[i];
          if (charType & (TYPE_R | TYPE_AL)) {
            return 1
          }
          if ((charType & (TYPE_B | TYPE_L)) || (isFSI && charType === TYPE_PDI)) {
            return 0
          }
          if (charType & ISOLATE_INIT_TYPES) {
            const pdi = indexOfMatchingPDI(i);
            i = pdi === -1 ? string.length : pdi;
          }
        }
        return 0
      }

      function indexOfMatchingPDI (isolateStart) {
        // 3.1.2 BD9
        let isolationLevel = 1;
        for (let i = isolateStart + 1; i < string.length; i++) {
          const charType = charTypes[i];
          if (charType & TYPE_B) {
            break
          }
          if (charType & TYPE_PDI) {
            if (--isolationLevel === 0) {
              return i
            }
          } else if (charType & ISOLATE_INIT_TYPES) {
            isolationLevel++;
          }
        }
        return -1
      }

      function getEmbedDirection (i) {
        return (embedLevels[i] & 1) ? TYPE_R : TYPE_L
      }

    }

    // Bidi mirrored chars data, auto generated
    var data = "14>1,j>2,t>2,u>2,1a>g,2v3>1,1>1,1ge>1,1wd>1,b>1,1j>1,f>1,ai>3,-2>3,+1,8>1k0,-1jq>1y7,-1y6>1hf,-1he>1h6,-1h5>1ha,-1h8>1qi,-1pu>1,6>3u,-3s>7,6>1,1>1,f>1,1>1,+2,3>1,1>1,+13,4>1,1>1,6>1eo,-1ee>1,3>1mg,-1me>1mk,-1mj>1mi,-1mg>1mi,-1md>1,1>1,+2,1>10k,-103>1,1>1,4>1,5>1,1>1,+10,3>1,1>8,-7>8,+1,-6>7,+1,a>1,1>1,u>1,u6>1,1>1,+5,26>1,1>1,2>1,2>2,8>1,7>1,4>1,1>1,+5,b8>1,1>1,+3,1>3,-2>1,2>1,1>1,+2,c>1,3>1,1>1,+2,h>1,3>1,a>1,1>1,2>1,3>1,1>1,d>1,f>1,3>1,1a>1,1>1,6>1,7>1,13>1,k>1,1>1,+19,4>1,1>1,+2,2>1,1>1,+18,m>1,a>1,1>1,lk>1,1>1,4>1,2>1,f>1,3>1,1>1,+3,db>1,1>1,+3,3>1,1>1,+2,14qm>1,1>1,+1,6>1,4j>1,j>2,t>2,u>2,2>1,+1";

    let mirrorMap;

    function parse () {
      if (!mirrorMap) {
        //const start = performance.now()
        const { map, reverseMap } = parseCharacterMap(data, true);
        // Combine both maps into one
        reverseMap.forEach((value, key) => {
          map.set(key, value);
        });
        mirrorMap = map;
        //console.log(`mirrored chars parsed in ${performance.now() - start}ms`)
      }
    }

    function getMirroredCharacter (char) {
      parse();
      return mirrorMap.get(char) || null
    }

    /**
     * Given a string and its resolved embedding levels, build a map of indices to replacement chars
     * for any characters in right-to-left segments that have defined mirrored characters.
     * @param string
     * @param embeddingLevels
     * @param [start]
     * @param [end]
     * @return {Map<number, string>}
     */
    function getMirroredCharactersMap(string, embeddingLevels, start, end) {
      let strLen = string.length;
      start = Math.max(0, start == null ? 0 : +start);
      end = Math.min(strLen - 1, end == null ? strLen - 1 : +end);

      const map = new Map();
      for (let i = start; i <= end; i++) {
        if (embeddingLevels[i] & 1) { //only odd (rtl) levels
          const mirror = getMirroredCharacter(string[i]);
          if (mirror !== null) {
            map.set(i, mirror);
          }
        }
      }
      return map
    }

    /**
     * Given a start and end denoting a single line within a string, and a set of precalculated
     * bidi embedding levels, produce a list of segments whose ordering should be flipped, in sequence.
     * @param {string} string - the full input string
     * @param {GetEmbeddingLevelsResult} embeddingLevelsResult - the result object from getEmbeddingLevels
     * @param {number} [start] - first character in a subset of the full string
     * @param {number} [end] - last character in a subset of the full string
     * @return {number[][]} - the list of start/end segments that should be flipped, in order.
     */
    function getReorderSegments(string, embeddingLevelsResult, start, end) {
      let strLen = string.length;
      start = Math.max(0, start == null ? 0 : +start);
      end = Math.min(strLen - 1, end == null ? strLen - 1 : +end);

      const segments = [];
      embeddingLevelsResult.paragraphs.forEach(paragraph => {
        const lineStart = Math.max(start, paragraph.start);
        const lineEnd = Math.min(end, paragraph.end);
        if (lineStart < lineEnd) {
          // Local slice for mutation
          const lineLevels = embeddingLevelsResult.levels.slice(lineStart, lineEnd + 1);

          // 3.4 L1.4: Reset any sequence of whitespace characters and/or isolate formatting characters at the
          // end of the line to the paragraph level.
          for (let i = lineEnd; i >= lineStart && (getBidiCharType(string[i]) & TRAILING_TYPES); i--) {
            lineLevels[i] = paragraph.level;
          }

          // L2. From the highest level found in the text to the lowest odd level on each line, including intermediate levels
          // not actually present in the text, reverse any contiguous sequence of characters that are at that level or higher.
          let maxLevel = paragraph.level;
          let minOddLevel = Infinity;
          for (let i = 0; i < lineLevels.length; i++) {
            const level = lineLevels[i];
            if (level > maxLevel) maxLevel = level;
            if (level < minOddLevel) minOddLevel = level | 1;
          }
          for (let lvl = maxLevel; lvl >= minOddLevel; lvl--) {
            for (let i = 0; i < lineLevels.length; i++) {
              if (lineLevels[i] >= lvl) {
                const segStart = i;
                while (i + 1 < lineLevels.length && lineLevels[i + 1] >= lvl) {
                  i++;
                }
                if (i > segStart) {
                  segments.push([segStart + start, i + start]);
                }
              }
            }
          }
        }
      });
      return segments
    }

    /**
     * @param {string} string
     * @param {GetEmbeddingLevelsResult} embedLevelsResult
     * @param {number} [start]
     * @param {number} [end]
     * @return {string} the new string with bidi segments reordered
     */
    function getReorderedString(string, embedLevelsResult, start, end) {
      const indices = getReorderedIndices(string, embedLevelsResult, start, end);
      const chars = [...string];
      indices.forEach((charIndex, i) => {
        chars[i] = (
          (embedLevelsResult.levels[charIndex] & 1) ? getMirroredCharacter(string[charIndex]) : null
        ) || string[charIndex];
      });
      return chars.join('')
    }

    /**
     * @param {string} string
     * @param {GetEmbeddingLevelsResult} embedLevelsResult
     * @param {number} [start]
     * @param {number} [end]
     * @return {number[]} an array with character indices in their new bidi order
     */
    function getReorderedIndices(string, embedLevelsResult, start, end) {
      const segments = getReorderSegments(string, embedLevelsResult, start, end);
      // Fill an array with indices
      const indices = [];
      for (let i = 0; i < string.length; i++) {
        indices[i] = i;
      }
      // Reverse each segment in order
      segments.forEach(([start, end]) => {
        const slice = indices.slice(start, end + 1);
        for (let i = slice.length; i--;) {
          indices[end - i] = slice[i];
        }
      });
      return indices
    }

    exports.closingToOpeningBracket = closingToOpeningBracket;
    exports.getBidiCharType = getBidiCharType;
    exports.getBidiCharTypeName = getBidiCharTypeName;
    exports.getCanonicalBracket = getCanonicalBracket;
    exports.getEmbeddingLevels = getEmbeddingLevels;
    exports.getMirroredCharacter = getMirroredCharacter;
    exports.getMirroredCharactersMap = getMirroredCharactersMap;
    exports.getReorderSegments = getReorderSegments;
    exports.getReorderedIndices = getReorderedIndices;
    exports.getReorderedString = getReorderedString;
    exports.openingToClosingBracket = openingToClosingBracket;

    Object.defineProperty(exports, '__esModule', { value: true });

    return exports;

  }({}));
  return bidi}

  /**
   * Regular expression for matching the `void main() {` opener line in GLSL.
   * @type {RegExp}
   */
  const voidMainRegExp = /\bvoid\s+main\s*\(\s*\)\s*{/g;

  /**
   * Recursively expands all `#include <xyz>` statements within string of shader code.
   * Copied from three's WebGLProgram#parseIncludes for external use.
   *
   * @param {string} source - The GLSL source code to evaluate
   * @return {string} The GLSL code with all includes expanded
   */
  function expandShaderIncludes( source ) {
    const pattern = /^[ \t]*#include +<([\w\d./]+)>/gm;
    function replace(match, include) {
      let chunk = THREE.ShaderChunk[include];
      return chunk ? expandShaderIncludes(chunk) : match
    }
    return source.replace( pattern, replace )
  }

  /*
   * This is a direct copy of MathUtils.generateUUID from Three.js, to preserve compatibility with three
   * versions before 0.113.0 as it was changed from Math to MathUtils in that version.
   * https://github.com/mrdoob/three.js/blob/dd8b5aa3b270c17096b90945cd2d6d1b13aaec53/src/math/MathUtils.js#L16
   */

  const _lut = [];

  for (let i = 0; i < 256; i++) {
    _lut[i] = (i < 16 ? '0' : '') + (i).toString(16);
  }

  function generateUUID() {

    // http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript/21963136#21963136

    const d0 = Math.random() * 0xffffffff | 0;
    const d1 = Math.random() * 0xffffffff | 0;
    const d2 = Math.random() * 0xffffffff | 0;
    const d3 = Math.random() * 0xffffffff | 0;
    const uuid = _lut[d0 & 0xff] + _lut[d0 >> 8 & 0xff] + _lut[d0 >> 16 & 0xff] + _lut[d0 >> 24 & 0xff] + '-' +
      _lut[d1 & 0xff] + _lut[d1 >> 8 & 0xff] + '-' + _lut[d1 >> 16 & 0x0f | 0x40] + _lut[d1 >> 24 & 0xff] + '-' +
      _lut[d2 & 0x3f | 0x80] + _lut[d2 >> 8 & 0xff] + '-' + _lut[d2 >> 16 & 0xff] + _lut[d2 >> 24 & 0xff] +
      _lut[d3 & 0xff] + _lut[d3 >> 8 & 0xff] + _lut[d3 >> 16 & 0xff] + _lut[d3 >> 24 & 0xff];

    // .toUpperCase() here flattens concatenated strings to save heap memory space.
    return uuid.toUpperCase()

  }

  // Local assign polyfill to avoid importing troika-core
  const assign$1 = Object.assign || function(/*target, ...sources*/) {
    let target = arguments[0];
    for (let i = 1, len = arguments.length; i < len; i++) {
      let source = arguments[i];
      if (source) {
        for (let prop in source) {
          if (source.hasOwnProperty(prop)) {
            target[prop] = source[prop];
          }
        }
      }
    }
    return target
  };


  const epoch = Date.now();
  const CONSTRUCTOR_CACHE = new WeakMap();
  const SHADER_UPGRADE_CACHE = new Map();

  // Material ids must be integers, but we can't access the increment from Three's `Material` module,
  // so let's choose a sufficiently large starting value that should theoretically never collide.
  let materialInstanceId = 1e10;

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
   * @param {String} options.timeUniform - If specified, a uniform of this name will be injected into
   *        both shaders, and it will automatically be updated on each render frame with a number of
   *        elapsed milliseconds. The "zero" epoch time is not significant so don't rely on this as a
   *        true calendar time.
   * @param {String} options.vertexDefs - Custom GLSL code to inject into the vertex shader's top-level
   *        definitions, above the `void main()` function.
   * @param {String} options.vertexMainIntro - Custom GLSL code to inject at the top of the vertex
   *        shader's `void main` function.
   * @param {String} options.vertexMainOutro - Custom GLSL code to inject at the end of the vertex
   *        shader's `void main` function.
   * @param {String} options.vertexTransform - Custom GLSL code to manipulate the `position`, `normal`,
   *        and/or `uv` vertex attributes. This code will be wrapped within a standalone function with
   *        those attributes exposed by their normal names as read/write values.
   * @param {String} options.fragmentDefs - Custom GLSL code to inject into the fragment shader's top-level
   *        definitions, above the `void main()` function.
   * @param {String} options.fragmentMainIntro - Custom GLSL code to inject at the top of the fragment
   *        shader's `void main` function.
   * @param {String} options.fragmentMainOutro - Custom GLSL code to inject at the end of the fragment
   *        shader's `void main` function. You can manipulate `gl_FragColor` here but keep in mind it goes
   *        after any of ThreeJS's color postprocessing shader chunks (tonemapping, fog, etc.), so if you
   *        want those to apply to your changes use `fragmentColorTransform` instead.
   * @param {String} options.fragmentColorTransform - Custom GLSL code to manipulate the `gl_FragColor`
   *        output value. Will be injected near the end of the `void main` function, but before any
   *        of ThreeJS's color postprocessing shader chunks (tonemapping, fog, etc.), and before the
   *        `fragmentMainOutro`.
   * @param {function<{vertexShader,fragmentShader}>:{vertexShader,fragmentShader}} options.customRewriter - A function
   *        for performing custom rewrites of the full shader code. Useful if you need to do something
   *        special that's not covered by the other builtin options. This function will be executed before
   *        any other transforms are applied.
   * @param {boolean} options.chained - Set to `true` to prototype-chain the derived material to the base
   *        material, rather than the default behavior of copying it. This allows the derived material to
   *        automatically pick up changes made to the base material and its properties. This can be useful
   *        where the derived material is hidden from the user as an implementation detail, allowing them
   *        to work with the original material like normal. But it can result in unexpected behavior if not
   *        handled carefully.
   *
   * @return {THREE.Material}
   *
   * The returned material will also have two new methods, `getDepthMaterial()` and `getDistanceMaterial()`,
   * which can be called to get a variant of the derived material for use in shadow casting. If the
   * target mesh is expected to cast shadows, then you can assign these to the mesh's `customDepthMaterial`
   * (for directional and spot lights) and/or `customDistanceMaterial` (for point lights) properties to
   * allow the cast shadow to honor your derived shader's vertex transforms and discarded fragments. These
   * will also set a custom `#define IS_DEPTH_MATERIAL` or `#define IS_DISTANCE_MATERIAL` that you can look
   * for in your derived shaders with `#ifdef` to customize their behavior for the depth or distance
   * scenarios, e.g. skipping antialiasing or expensive shader logic.
   */
  function createDerivedMaterial(baseMaterial, options) {
    // Generate a key that is unique to the content of these `options`. We'll use this
    // throughout for caching and for generating the upgraded shader code. This increases
    // the likelihood that the resulting shaders will line up across multiple calls so
    // their GL programs can be shared and cached.
    const optionsKey = getKeyForOptions(options);

    // First check to see if we've already derived from this baseMaterial using this
    // unique set of options, and if so reuse the constructor to avoid some allocations.
    let ctorsByDerivation = CONSTRUCTOR_CACHE.get(baseMaterial);
    if (!ctorsByDerivation) {
      CONSTRUCTOR_CACHE.set(baseMaterial, (ctorsByDerivation = Object.create(null)));
    }
    if (ctorsByDerivation[optionsKey]) {
      return new ctorsByDerivation[optionsKey]()
    }

    const privateBeforeCompileProp = `_onBeforeCompile${optionsKey}`;

    // Private onBeforeCompile handler that injects the modified shaders and uniforms when
    // the renderer switches to this material's program
    const onBeforeCompile = function (shaderInfo) {
      baseMaterial.onBeforeCompile.call(this, shaderInfo);

      // Upgrade the shaders, caching the result by incoming source code
      const cacheKey = optionsKey + '|||' + shaderInfo.vertexShader + '|||' + shaderInfo.fragmentShader;
      let upgradedShaders = SHADER_UPGRADE_CACHE[cacheKey];
      if (!upgradedShaders) {
        const upgraded = upgradeShaders(shaderInfo, options, optionsKey);
        upgradedShaders = SHADER_UPGRADE_CACHE[cacheKey] = upgraded;
      }

      // Inject upgraded shaders and uniforms into the program
      shaderInfo.vertexShader = upgradedShaders.vertexShader;
      shaderInfo.fragmentShader = upgradedShaders.fragmentShader;
      assign$1(shaderInfo.uniforms, this.uniforms);

      // Inject auto-updating time uniform if requested
      if (options.timeUniform) {
        shaderInfo.uniforms[options.timeUniform] = {
          get value() {return Date.now() - epoch}
        };
      }

      // Users can still add their own handlers on top of ours
      if (this[privateBeforeCompileProp]) {
        this[privateBeforeCompileProp](shaderInfo);
      }
    };

    const DerivedMaterial = function DerivedMaterial() {
      return derive(options.chained ? baseMaterial : baseMaterial.clone())
    };

    const derive = function(base) {
      // Prototype chain to the base material
      const derived = Object.create(base, descriptor);

      // Store the baseMaterial for reference; this is always the original even when cloning
      Object.defineProperty(derived, 'baseMaterial', { value: baseMaterial });

      // Needs its own ids
      Object.defineProperty(derived, 'id', { value: materialInstanceId++ });
      derived.uuid = generateUUID();

      // Merge uniforms, defines, and extensions
      derived.uniforms = assign$1({}, base.uniforms, options.uniforms);
      derived.defines = assign$1({}, base.defines, options.defines);
      derived.defines[`TROIKA_DERIVED_MATERIAL_${optionsKey}`] = ''; //force a program change from the base material
      derived.extensions = assign$1({}, base.extensions, options.extensions);

      // Don't inherit EventDispatcher listeners
      derived._listeners = undefined;

      return derived
    };

    const descriptor = {
      constructor: {value: DerivedMaterial},
      isDerivedMaterial: {value: true},

      customProgramCacheKey: {
        writable: true,
        configurable: true,
        value: function () {
          return optionsKey
        }
      },

      onBeforeCompile: {
        get() {
          return onBeforeCompile
        },
        set(fn) {
          this[privateBeforeCompileProp] = fn;
        }
      },

      copy: {
        writable: true,
        configurable: true,
        value: function (source) {
          baseMaterial.copy.call(this, source);
          if (!baseMaterial.isShaderMaterial && !baseMaterial.isDerivedMaterial) {
            assign$1(this.extensions, source.extensions);
            assign$1(this.defines, source.defines);
            assign$1(this.uniforms, THREE.UniformsUtils.clone(source.uniforms));
          }
          return this
        }
      },

      clone: {
        writable: true,
        configurable: true,
        value: function () {
          const newBase = new baseMaterial.constructor();
          return derive(newBase).copy(this)
        }
      },

      /**
       * Utility to get a MeshDepthMaterial that will honor this derived material's vertex
       * transformations and discarded fragments.
       */
      getDepthMaterial: {
        writable: true,
        configurable: true,
        value: function() {
          let depthMaterial = this._depthMaterial;
          if (!depthMaterial) {
            depthMaterial = this._depthMaterial = createDerivedMaterial(
              baseMaterial.isDerivedMaterial
                ? baseMaterial.getDepthMaterial()
                : new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }),
              options
            );
            depthMaterial.defines.IS_DEPTH_MATERIAL = '';
            depthMaterial.uniforms = this.uniforms; //automatically recieve same uniform values
          }
          return depthMaterial
        }
      },

      /**
       * Utility to get a MeshDistanceMaterial that will honor this derived material's vertex
       * transformations and discarded fragments.
       */
      getDistanceMaterial: {
        writable: true,
        configurable: true,
        value: function() {
          let distanceMaterial = this._distanceMaterial;
          if (!distanceMaterial) {
            distanceMaterial = this._distanceMaterial = createDerivedMaterial(
              baseMaterial.isDerivedMaterial
                ? baseMaterial.getDistanceMaterial()
                : new THREE.MeshDistanceMaterial(),
              options
            );
            distanceMaterial.defines.IS_DISTANCE_MATERIAL = '';
            distanceMaterial.uniforms = this.uniforms; //automatically recieve same uniform values
          }
          return distanceMaterial
        }
      },

      dispose: {
        writable: true,
        configurable: true,
        value() {
          const {_depthMaterial, _distanceMaterial} = this;
          if (_depthMaterial) _depthMaterial.dispose();
          if (_distanceMaterial) _distanceMaterial.dispose();
          baseMaterial.dispose.call(this);
        }
      }
    };

    ctorsByDerivation[optionsKey] = DerivedMaterial;
    return new DerivedMaterial()
  }


  function upgradeShaders({vertexShader, fragmentShader}, options, key) {
    let {
      vertexDefs,
      vertexMainIntro,
      vertexMainOutro,
      vertexTransform,
      fragmentDefs,
      fragmentMainIntro,
      fragmentMainOutro,
      fragmentColorTransform,
      customRewriter,
      timeUniform
    } = options;

    vertexDefs = vertexDefs || '';
    vertexMainIntro = vertexMainIntro || '';
    vertexMainOutro = vertexMainOutro || '';
    fragmentDefs = fragmentDefs || '';
    fragmentMainIntro = fragmentMainIntro || '';
    fragmentMainOutro = fragmentMainOutro || '';

    // Expand includes if needed
    if (vertexTransform || customRewriter) {
      vertexShader = expandShaderIncludes(vertexShader);
    }
    if (fragmentColorTransform || customRewriter) {
      // We need to be able to find postprocessing chunks after include expansion in order to
      // put them after the fragmentColorTransform, so mark them with comments first. Even if
      // this particular derivation doesn't have a fragmentColorTransform, other derivations may,
      // so we still mark them.
      fragmentShader = fragmentShader.replace(
        /^[ \t]*#include <((?:tonemapping|encodings|fog|premultiplied_alpha|dithering)_fragment)>/gm,
        '\n//!BEGIN_POST_CHUNK $1\n$&\n//!END_POST_CHUNK\n'
      );
      fragmentShader = expandShaderIncludes(fragmentShader);
    }

    // Apply custom rewriter function
    if (customRewriter) {
      let res = customRewriter({vertexShader, fragmentShader});
      vertexShader = res.vertexShader;
      fragmentShader = res.fragmentShader;
    }

    // The fragmentColorTransform needs to go before any postprocessing chunks, so extract
    // those and re-insert them into the outro in the correct place:
    if (fragmentColorTransform) {
      let postChunks = [];
      fragmentShader = fragmentShader.replace(
        /^\/\/!BEGIN_POST_CHUNK[^]+?^\/\/!END_POST_CHUNK/gm, // [^]+? = non-greedy match of any chars including newlines
        match => {
          postChunks.push(match);
          return ''
        }
      );
      fragmentMainOutro = `${fragmentColorTransform}\n${postChunks.join('\n')}\n${fragmentMainOutro}`;
    }

    // Inject auto-updating time uniform if requested
    if (timeUniform) {
      const code = `\nuniform float ${timeUniform};\n`;
      vertexDefs = code + vertexDefs;
      fragmentDefs = code + fragmentDefs;
    }

    // Inject a function for the vertexTransform and rename all usages of position/normal/uv
    if (vertexTransform) {
      // Hoist these defs to the very top so they work in other function defs
      vertexShader = `vec3 troika_position_${key};
vec3 troika_normal_${key};
vec2 troika_uv_${key};
${vertexShader}
`;
      vertexDefs = `${vertexDefs}
void troikaVertexTransform${key}(inout vec3 position, inout vec3 normal, inout vec2 uv) {
  ${vertexTransform}
}
`;
      vertexMainIntro = `
troika_position_${key} = vec3(position);
troika_normal_${key} = vec3(normal);
troika_uv_${key} = vec2(uv);
troikaVertexTransform${key}(troika_position_${key}, troika_normal_${key}, troika_uv_${key});
${vertexMainIntro}
`;
      vertexShader = vertexShader.replace(/\b(position|normal|uv)\b/g, (match, match1, index, fullStr) => {
        return /\battribute\s+vec[23]\s+$/.test(fullStr.substr(0, index)) ? match1 : `troika_${match1}_${key}`
      });
    }

    // Inject defs and intro/outro snippets
    vertexShader = injectIntoShaderCode(vertexShader, key, vertexDefs, vertexMainIntro, vertexMainOutro);
    fragmentShader = injectIntoShaderCode(fragmentShader, key, fragmentDefs, fragmentMainIntro, fragmentMainOutro);

    return {
      vertexShader,
      fragmentShader
    }
  }

  function injectIntoShaderCode(shaderCode, id, defs, intro, outro) {
    if (intro || outro || defs) {
      shaderCode = shaderCode.replace(voidMainRegExp, `
${defs}
void troikaOrigMain${id}() {`
      );
      shaderCode += `
void main() {
  ${intro}
  troikaOrigMain${id}();
  ${outro}
}`;
    }
    return shaderCode
  }


  function optionsJsonReplacer(key, value) {
    return key === 'uniforms' ? undefined : typeof value === 'function' ? value.toString() : value
  }

  let _idCtr = 0;
  const optionsHashesToIds = new Map();
  function getKeyForOptions(options) {
    const optionsHash = JSON.stringify(options, optionsJsonReplacer);
    let id = optionsHashesToIds.get(optionsHash);
    if (id == null) {
      optionsHashesToIds.set(optionsHash, (id = ++_idCtr));
    }
    return id
  }

  /**
   * Initializes and returns a function to generate an SDF texture for a given glyph.
   * @param {function} createGlyphSegmentsIndex - factory for a GlyphSegmentsIndex implementation.
   * @param {number} config.sdfExponent
   * @param {number} config.sdfMargin
   *
   * @return {function(Object): {renderingBounds: [minX, minY, maxX, maxY], textureData: Uint8Array}}
   */
  function createSDFGenerator(createGlyphSegmentsIndex, config) {
    const { sdfExponent, sdfMargin } = config;

    /**
     * How many straight line segments to use when approximating a glyph's quadratic/cubic bezier curves.
     */
    const CURVE_POINTS = 16;

    /**
     * Find the point on a quadratic bezier curve at t where t is in the range [0, 1]
     */
    function pointOnQuadraticBezier(x0, y0, x1, y1, x2, y2, t) {
      const t2 = 1 - t;
      return {
        x: t2 * t2 * x0 + 2 * t2 * t * x1 + t * t * x2,
        y: t2 * t2 * y0 + 2 * t2 * t * y1 + t * t * y2
      }
    }

    /**
     * Find the point on a cubic bezier curve at t where t is in the range [0, 1]
     */
    function pointOnCubicBezier(x0, y0, x1, y1, x2, y2, x3, y3, t) {
      const t2 = 1 - t;
      return {
        x: t2 * t2 * t2 * x0 + 3 * t2 * t2 * t * x1 + 3 * t2 * t * t * x2 + t * t * t * x3,
        y: t2 * t2 * t2 * y0 + 3 * t2 * t2 * t * y1 + 3 * t2 * t * t * y2 + t * t * t * y3
      }
    }

    /**
     * Generate an SDF texture segment for a single glyph.
     * @param {object} glyphObj
     * @param {number} sdfSize - the length of one side of the SDF image.
     *        Larger images encode more details. Must be a power of 2.
     * @return {{textureData: Uint8Array, renderingBounds: *[]}}
     */
    function generateSDF(glyphObj, sdfSize) {
      //console.time('glyphSDF')

      const textureData = new Uint8Array(sdfSize * sdfSize);

      // Determine mapping between glyph grid coords and sdf grid coords
      const glyphW = glyphObj.xMax - glyphObj.xMin;
      const glyphH = glyphObj.yMax - glyphObj.yMin;

      // Choose a maximum search distance radius in font units, based on the glyph's max dimensions
      const fontUnitsMaxSearchDist = Math.max(glyphW, glyphH);

      // Margin - add an extra 0.5 over the configured value because the outer 0.5 doesn't contain
      // useful interpolated values and will be ignored anyway.
      const fontUnitsMargin = Math.max(glyphW, glyphH) / sdfSize * (sdfMargin * sdfSize + 0.5);

      // Metrics of the texture/quad in font units
      const textureMinFontX = glyphObj.xMin - fontUnitsMargin;
      const textureMinFontY = glyphObj.yMin - fontUnitsMargin;
      const textureMaxFontX = glyphObj.xMax + fontUnitsMargin;
      const textureMaxFontY = glyphObj.yMax + fontUnitsMargin;
      const fontUnitsTextureWidth = textureMaxFontX - textureMinFontX;
      const fontUnitsTextureHeight = textureMaxFontY - textureMinFontY;
      const fontUnitsTextureMaxDim = Math.max(fontUnitsTextureWidth, fontUnitsTextureHeight);

      function textureXToFontX(x) {
        return textureMinFontX + fontUnitsTextureWidth * x / sdfSize
      }

      function textureYToFontY(y) {
        return textureMinFontY + fontUnitsTextureHeight * y / sdfSize
      }

      if (glyphObj.pathCommandCount) { //whitespace chars will have no commands, so we can skip all this
        // Decompose all paths into straight line segments and add them to a quadtree
        const lineSegmentsIndex = createGlyphSegmentsIndex(glyphObj);
        let firstX, firstY, prevX, prevY;
        glyphObj.forEachPathCommand((type, x0, y0, x1, y1, x2, y2) => {
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
              let prevPoint = {x: prevX, y: prevY};
              for (let i = 1; i < CURVE_POINTS; i++) {
                let nextPoint = pointOnQuadraticBezier(
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
              let prevPoint = {x: prevX, y: prevY};
              for (let i = 1; i < CURVE_POINTS; i++) {
                let nextPoint = pointOnCubicBezier(
                  prevX, prevY,
                  x0, y0,
                  x1, y1,
                  x2, y2,
                  i / (CURVE_POINTS - 1)
                );
                lineSegmentsIndex.addLineSegment(prevPoint.x, prevPoint.y, nextPoint.x, nextPoint.y);
                prevPoint = nextPoint;
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
        for (let sdfX = 0; sdfX < sdfSize; sdfX++) {
          for (let sdfY = 0; sdfY < sdfSize; sdfY++) {
            const signedDist = lineSegmentsIndex.findNearestSignedDistance(
              textureXToFontX(sdfX + 0.5),
              textureYToFontY(sdfY + 0.5),
              fontUnitsMaxSearchDist
            );

            // Use an exponential scale to ensure the texels very near the glyph path have adequate
            // precision, while allowing the distance field to cover the entire texture, given that
            // there are only 8 bits available. Formula visualized: https://www.desmos.com/calculator/uiaq5aqiam
            let alpha = Math.pow((1 - Math.abs(signedDist) / fontUnitsTextureMaxDim), sdfExponent) / 2;
            if (signedDist < 0) {
              alpha = 1 - alpha;
            }

            alpha = Math.max(0, Math.min(255, Math.round(alpha * 255))); //clamp
            textureData[sdfY * sdfSize + sdfX] = alpha;
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
   * It is important that this function has no closure dependencies, so that it can be easily injected
   * into the source for a Worker without requiring a build step or complex dependency loading. All its
   * dependencies must be passed in at initialization.
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
  function createFontProcessor(fontParser, sdfGenerator, bidi, config) {

    const {
      defaultFontURL
    } = config;


    /**
     * @private
     * Holds data about font glyphs and how they relate to SDF atlases
     *
     * {
     *   'fontUrl@sdfSize': {
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
    const fontAtlases = Object.create(null);

    /**
     * Holds parsed font objects by url
     */
    const fonts = Object.create(null);

    const INF = Infinity;

    // Set of Unicode Default_Ignorable_Code_Point characters, these will not produce visible glyphs
    const DEFAULT_IGNORABLE_CHARS = /[\u00AD\u034F\u061C\u115F-\u1160\u17B4-\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFF8]/;

    /**
     * Load a given font url
     */
    function doLoadFont(url, callback) {
      function tryLoad() {
        const onError = err => {
          console.error(`Failure loading font ${url}${url === defaultFontURL ? '' : '; trying fallback'}`, err);
          if (url !== defaultFontURL) {
            url = defaultFontURL;
            tryLoad();
          }
        };
        try {
          const request = new XMLHttpRequest();
          request.open('get', url, true);
          request.responseType = 'arraybuffer';
          request.onload = function () {
            if (request.status >= 400) {
              onError(new Error(request.statusText));
            }
            else if (request.status > 0) {
              try {
                const fontObj = fontParser(request.response);
                callback(fontObj);
              } catch (e) {
                onError(e);
              }
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
      if (!fontUrl) fontUrl = defaultFontURL;
      let font = fonts[fontUrl];
      if (font) {
        // if currently loading font, add to callbacks, otherwise execute immediately
        if (font.pending) {
          font.pending.push(callback);
        } else {
          callback(font);
        }
      } else {
        fonts[fontUrl] = {pending: [callback]};
        doLoadFont(fontUrl, fontObj => {
          let callbacks = fonts[fontUrl].pending;
          fonts[fontUrl] = fontObj;
          callbacks.forEach(cb => cb(fontObj));
        });
      }
    }


    /**
     * Get the atlas data for a given font url, loading it from the network and initializing
     * its atlas data objects if necessary.
     */
    function getSdfAtlas(fontUrl, sdfGlyphSize, callback) {
      if (!fontUrl) fontUrl = defaultFontURL;
      let atlasKey = `${fontUrl}@${sdfGlyphSize}`;
      let atlas = fontAtlases[atlasKey];
      if (atlas) {
        callback(atlas);
      } else {
        loadFont(fontUrl, fontObj => {
          atlas = fontAtlases[atlasKey] || (fontAtlases[atlasKey] = {
            fontObj: fontObj,
            glyphs: {},
            glyphCount: 0
          });
          callback(atlas);
        });
      }
    }


    /**
     * Main entry point.
     * Process a text string with given font and formatting parameters, and return all info
     * necessary to render all its glyphs.
     */
    function process(
      {
        text='',
        font=defaultFontURL,
        sdfGlyphSize=64,
        fontSize=1,
        letterSpacing=0,
        lineHeight='normal',
        maxWidth=INF,
        direction,
        textAlign='left',
        textIndent=0,
        whiteSpace='normal',
        overflowWrap='normal',
        anchorX = 0,
        anchorY = 0,
        includeCaretPositions=false,
        chunkedBoundsSize=8192,
        colorRanges=null
      },
      callback,
      metricsOnly=false
    ) {
      const mainStart = now();
      const timings = {total: 0, fontLoad: 0, layout: 0, sdf: {}, sdfTotal: 0};

      // Ensure newlines are normalized
      if (text.indexOf('\r') > -1) {
        console.warn('FontProcessor.process: got text with \\r chars; normalizing to \\n');
        text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      }

      // Ensure we've got numbers not strings
      fontSize = +fontSize;
      letterSpacing = +letterSpacing;
      maxWidth = +maxWidth;
      lineHeight = lineHeight || 'normal';
      textIndent = +textIndent;

      getSdfAtlas(font, sdfGlyphSize, atlas => {
        const fontObj = atlas.fontObj;
        const hasMaxWidth = isFinite(maxWidth);
        let newGlyphs = null;
        let glyphBounds = null;
        let glyphAtlasIndices = null;
        let glyphColors = null;
        let caretPositions = null;
        let visibleBounds = null;
        let chunkedBounds = null;
        let maxLineWidth = 0;
        let renderableGlyphCount = 0;
        let canWrap = whiteSpace !== 'nowrap';
        const {ascender, descender, unitsPerEm} = fontObj;
        timings.fontLoad = now() - mainStart;
        const layoutStart = now();

        // Find conversion between native font units and fontSize units; this will already be done
        // for the gx/gy values below but everything else we'll need to convert
        const fontSizeMult = fontSize / unitsPerEm;

        // Determine appropriate value for 'normal' line height based on the font's actual metrics
        // TODO this does not guarantee individual glyphs won't exceed the line height, e.g. Roboto; should we use yMin/Max instead?
        if (lineHeight === 'normal') {
          lineHeight = (ascender - descender) / unitsPerEm;
        }

        // Determine line height and leading adjustments
        lineHeight = lineHeight * fontSize;
        const halfLeading = (lineHeight - (ascender - descender) * fontSizeMult) / 2;
        const topBaseline = -(ascender * fontSizeMult + halfLeading);
        const caretHeight = Math.min(lineHeight, (ascender - descender) * fontSizeMult);
        const caretBottomOffset = (ascender + descender) / 2 * fontSizeMult - caretHeight / 2;

        // Distribute glyphs into lines based on wrapping
        let lineXOffset = textIndent;
        let currentLine = new TextLine();
        const lines = [currentLine];

        fontObj.forEachGlyph(text, fontSize, letterSpacing, (glyphObj, glyphX, charIndex) => {
          const char = text.charAt(charIndex);
          const glyphWidth = glyphObj.advanceWidth * fontSizeMult;
          const curLineCount = currentLine.count;
          let nextLine;

          // Calc isWhitespace and isEmpty once per glyphObj
          if (!('isEmpty' in glyphObj)) {
            glyphObj.isWhitespace = !!char && /\s/.test(char);
            glyphObj.isEmpty = glyphObj.xMin === glyphObj.xMax || glyphObj.yMin === glyphObj.yMax || DEFAULT_IGNORABLE_CHARS.test(char);
          }
          if (!glyphObj.isWhitespace && !glyphObj.isEmpty) {
            renderableGlyphCount++;
          }

          // If a non-whitespace character overflows the max width, we need to soft-wrap
          if (canWrap && hasMaxWidth && !glyphObj.isWhitespace && glyphX + glyphWidth + lineXOffset > maxWidth && curLineCount) {
            // If it's the first char after a whitespace, start a new line
            if (currentLine.glyphAt(curLineCount - 1).glyphObj.isWhitespace) {
              nextLine = new TextLine();
              lineXOffset = -glyphX;
            } else {
              // Back up looking for a whitespace character to wrap at
              for (let i = curLineCount; i--;) {
                // If we got the start of the line there's no soft break point; make hard break if overflowWrap='break-word'
                if (i === 0 && overflowWrap === 'break-word') {
                  nextLine = new TextLine();
                  lineXOffset = -glyphX;
                  break
                }
                // Found a soft break point; move all chars since it to a new line
                else if (currentLine.glyphAt(i).glyphObj.isWhitespace) {
                  nextLine = currentLine.splitAt(i + 1);
                  const adjustX = nextLine.glyphAt(0).x;
                  lineXOffset -= adjustX;
                  for (let j = nextLine.count; j--;) {
                    nextLine.glyphAt(j).x -= adjustX;
                  }
                  break
                }
              }
            }
            if (nextLine) {
              currentLine.isSoftWrapped = true;
              currentLine = nextLine;
              lines.push(currentLine);
              maxLineWidth = maxWidth; //after soft wrapping use maxWidth as calculated width
            }
          }

          let fly = currentLine.glyphAt(currentLine.count);
          fly.glyphObj = glyphObj;
          fly.x = glyphX + lineXOffset;
          fly.width = glyphWidth;
          fly.charIndex = charIndex;

          // Handle hard line breaks
          if (char === '\n') {
            currentLine = new TextLine();
            lines.push(currentLine);
            lineXOffset = -(glyphX + glyphWidth + (letterSpacing * fontSize)) + textIndent;
          }
        });

        // Calculate width of each line (excluding trailing whitespace) and maximum block width
        lines.forEach(line => {
          for (let i = line.count; i--;) {
            let {glyphObj, x, width} = line.glyphAt(i);
            if (!glyphObj.isWhitespace) {
              line.width = x + width;
              if (line.width > maxLineWidth) {
                maxLineWidth = line.width;
              }
              return
            }
          }
        });

        // Find overall position adjustments for anchoring
        let anchorXOffset = 0;
        let anchorYOffset = 0;
        if (anchorX) {
          if (typeof anchorX === 'number') {
            anchorXOffset = -anchorX;
          }
          else if (typeof anchorX === 'string') {
            anchorXOffset = -maxLineWidth * (
              anchorX === 'left' ? 0 :
              anchorX === 'center' ? 0.5 :
              anchorX === 'right' ? 1 :
              parsePercent(anchorX)
            );
          }
        }
        if (anchorY) {
          if (typeof anchorY === 'number') {
            anchorYOffset = -anchorY;
          }
          else if (typeof anchorY === 'string') {
            let height = lines.length * lineHeight;
            anchorYOffset = anchorY === 'top' ? 0 :
              anchorY === 'top-baseline' ? -topBaseline :
              anchorY === 'middle' ? height / 2 :
              anchorY === 'bottom' ? height :
              anchorY === 'bottom-baseline' ? height - halfLeading + descender * fontSizeMult :
              parsePercent(anchorY) * height;
          }
        }

        if (!metricsOnly) {
          // Resolve bidi levels
          const bidiLevelsResult = bidi.getEmbeddingLevels(text, direction);

          // Process each line, applying alignment offsets, adding each glyph to the atlas, and
          // collecting all renderable glyphs into a single collection.
          glyphBounds = new Float32Array(renderableGlyphCount * 4);
          glyphAtlasIndices = new Float32Array(renderableGlyphCount);
          visibleBounds = [INF, INF, -INF, -INF];
          chunkedBounds = [];
          let lineYOffset = topBaseline;
          if (includeCaretPositions) {
            caretPositions = new Float32Array(text.length * 3);
          }
          if (colorRanges) {
            glyphColors = new Uint8Array(renderableGlyphCount * 3);
          }
          let renderableGlyphIndex = 0;
          let prevCharIndex = -1;
          let colorCharIndex = -1;
          let chunk;
          let currentColor;
          lines.forEach((line, lineIndex) => {
            let {count:lineGlyphCount, width:lineWidth} = line;

            // Ignore empty lines
            if (lineGlyphCount > 0) {
              // Count trailing whitespaces, we want to ignore these for certain things
              let trailingWhitespaceCount = 0;
              for (let i = lineGlyphCount; i-- && line.glyphAt(i).glyphObj.isWhitespace;) {
                trailingWhitespaceCount++;
              }

              // Apply horizontal alignment adjustments
              let lineXOffset = 0;
              let justifyAdjust = 0;
              if (textAlign === 'center') {
                lineXOffset = (maxLineWidth - lineWidth) / 2;
              } else if (textAlign === 'right') {
                lineXOffset = maxLineWidth - lineWidth;
              } else if (textAlign === 'justify' && line.isSoftWrapped) {
                // count non-trailing whitespace characters, and we'll adjust the offsets per character in the next loop
                let whitespaceCount = 0;
                for (let i = lineGlyphCount - trailingWhitespaceCount; i--;) {
                  if (line.glyphAt(i).glyphObj.isWhitespace) {
                    whitespaceCount++;
                  }
                }
                justifyAdjust = (maxLineWidth - lineWidth) / whitespaceCount;
              }
              if (justifyAdjust || lineXOffset) {
                let justifyOffset = 0;
                for (let i = 0; i < lineGlyphCount; i++) {
                  let glyphInfo = line.glyphAt(i);
                  const glyphObj = glyphInfo.glyphObj;
                  glyphInfo.x += lineXOffset + justifyOffset;
                  // Expand non-trailing whitespaces for justify alignment
                  if (justifyAdjust !== 0 && glyphObj.isWhitespace && i < lineGlyphCount - trailingWhitespaceCount) {
                    justifyOffset += justifyAdjust;
                    glyphInfo.width += justifyAdjust;
                  }
                }
              }

              // Perform bidi range flipping
              const flips = bidi.getReorderSegments(
                text, bidiLevelsResult, line.glyphAt(0).charIndex, line.glyphAt(line.count - 1).charIndex
              );
              for (let fi = 0; fi < flips.length; fi++) {
                const [start, end] = flips[fi];
                // Map start/end string indices to indices in the line
                let left = Infinity, right = -Infinity;
                for (let i = 0; i < lineGlyphCount; i++) {
                  if (line.glyphAt(i).charIndex >= start) { // gte to handle removed characters
                    let startInLine = i, endInLine = i;
                    for (; endInLine < lineGlyphCount; endInLine++) {
                      let info = line.glyphAt(endInLine);
                      if (info.charIndex > end) {
                        break
                      }
                      if (endInLine < lineGlyphCount - trailingWhitespaceCount) { //don't include trailing ws in flip width
                        left = Math.min(left, info.x);
                        right = Math.max(right, info.x + info.width);
                      }
                    }
                    for (let j = startInLine; j < endInLine; j++) {
                      const glyphInfo = line.glyphAt(j);
                      glyphInfo.x = right - (glyphInfo.x + glyphInfo.width - left);
                    }
                    break
                  }
                }
              }

              // Assemble final data arrays
              let glyphObj;
              const setGlyphObj = g => glyphObj = g;
              for (let i = 0; i < lineGlyphCount; i++) {
                let glyphInfo = line.glyphAt(i);
                glyphObj = glyphInfo.glyphObj;

                // Replace mirrored characters in rtl
                const rtl = bidiLevelsResult.levels[glyphInfo.charIndex] & 1; //odd level means rtl
                if (rtl) {
                  const mirrored = bidi.getMirroredCharacter(text[glyphInfo.charIndex]);
                  if (mirrored) {
                    fontObj.forEachGlyph(mirrored, 0, 0, setGlyphObj);
                  }
                }

                // Add caret positions
                if (includeCaretPositions) {
                  const {charIndex} = glyphInfo;
                  const caretLeft = glyphInfo.x + anchorXOffset;
                  const caretRight = glyphInfo.x + glyphInfo.width + anchorXOffset;
                  caretPositions[charIndex * 3] = rtl ? caretRight : caretLeft; //start edge x
                  caretPositions[charIndex * 3 + 1] = rtl ? caretLeft : caretRight; //end edge x
                  caretPositions[charIndex * 3 + 2] = lineYOffset + caretBottomOffset + anchorYOffset; //common bottom y

                  // If we skipped any chars from the previous glyph (due to ligature subs), copy the
                  // previous glyph's info to those missing char indices. In the future we may try to
                  // use the font's LigatureCaretList table to get interior caret positions.
                  while (charIndex - prevCharIndex > 1) {
                    caretPositions[(prevCharIndex + 1) * 3] = caretPositions[prevCharIndex * 3];
                    caretPositions[(prevCharIndex + 1) * 3 + 1] = caretPositions[prevCharIndex * 3 + 1];
                    caretPositions[(prevCharIndex + 1) * 3 + 2] = caretPositions[prevCharIndex * 3 + 2];
                    prevCharIndex++;
                  }
                  prevCharIndex = charIndex;
                }

                // Track current color range
                if (colorRanges) {
                  const {charIndex} = glyphInfo;
                  while(charIndex > colorCharIndex) {
                    colorCharIndex++;
                    if (colorRanges.hasOwnProperty(colorCharIndex)) {
                      currentColor = colorRanges[colorCharIndex];
                    }
                  }
                }

                // Get atlas data for renderable glyphs
                if (!glyphObj.isWhitespace && !glyphObj.isEmpty) {
                  const idx = renderableGlyphIndex++;

                  // If we haven't seen this glyph yet, generate its SDF
                  let glyphAtlasInfo = atlas.glyphs[glyphObj.index];
                  if (!glyphAtlasInfo) {
                    const sdfStart = now();
                    const glyphSDFData = sdfGenerator(glyphObj, sdfGlyphSize);
                    timings.sdf[text.charAt(glyphInfo.charIndex)] = now() - sdfStart;

                    // Assign this glyph the next available atlas index
                    glyphSDFData.atlasIndex = atlas.glyphCount++;

                    // Queue it up in the response's newGlyphs list
                    if (!newGlyphs) newGlyphs = [];
                    newGlyphs.push(glyphSDFData);

                    // Store its metadata (not the texture) in our atlas info
                    glyphAtlasInfo = atlas.glyphs[glyphObj.index] = {
                      atlasIndex: glyphSDFData.atlasIndex,
                      glyphObj: glyphObj,
                      renderingBounds: glyphSDFData.renderingBounds
                    };
                  }

                  // Determine final glyph quad bounds and add them to the glyphBounds array
                  const bounds = glyphAtlasInfo.renderingBounds;
                  const startIdx = idx * 4;
                  const xStart = glyphInfo.x + anchorXOffset;
                  const yStart = lineYOffset + anchorYOffset;
                  glyphBounds[startIdx] = xStart + bounds[0] * fontSizeMult;
                  glyphBounds[startIdx + 1] = yStart + bounds[1] * fontSizeMult;
                  glyphBounds[startIdx + 2] = xStart + bounds[2] * fontSizeMult;
                  glyphBounds[startIdx + 3] = yStart + bounds[3] * fontSizeMult;

                  // Track total visible bounds
                  const visX0 = xStart + glyphObj.xMin * fontSizeMult;
                  const visY0 = yStart + glyphObj.yMin * fontSizeMult;
                  const visX1 = xStart + glyphObj.xMax * fontSizeMult;
                  const visY1 = yStart + glyphObj.yMax * fontSizeMult;
                  if (visX0 < visibleBounds[0]) visibleBounds[0] = visX0;
                  if (visY0 < visibleBounds[1]) visibleBounds[1] = visY0;
                  if (visX1 > visibleBounds[2]) visibleBounds[2] = visX1;
                  if (visY1 > visibleBounds[3]) visibleBounds[3] = visY1;

                  // Track bounding rects for each chunk of N glyphs
                  if (idx % chunkedBoundsSize === 0) {
                    chunk = {start: idx, end: idx, rect: [INF, INF, -INF, -INF]};
                    chunkedBounds.push(chunk);
                  }
                  chunk.end++;
                  const chunkRect = chunk.rect;
                  if (visX0 < chunkRect[0]) chunkRect[0] = visX0;
                  if (visY0 < chunkRect[1]) chunkRect[1] = visY0;
                  if (visX1 > chunkRect[2]) chunkRect[2] = visX1;
                  if (visY1 > chunkRect[3]) chunkRect[3] = visY1;

                  // Add to atlas indices array
                  glyphAtlasIndices[idx] = glyphAtlasInfo.atlasIndex;

                  // Add colors
                  if (colorRanges) {
                    const start = idx * 3;
                    glyphColors[start] = currentColor >> 16 & 255;
                    glyphColors[start + 1] = currentColor >> 8 & 255;
                    glyphColors[start + 2] = currentColor & 255;
                  }
                }
              }
            }

            // Increment y offset for next line
            lineYOffset -= lineHeight;
          });
        }

        // Timing stats
        for (let ch in timings.sdf) {
          timings.sdfTotal += timings.sdf[ch];
        }
        timings.layout = now() - layoutStart - timings.sdfTotal;
        timings.total = now() - mainStart;

        callback({
          glyphBounds, //rendering quad bounds for each glyph [x1, y1, x2, y2]
          glyphAtlasIndices, //atlas indices for each glyph
          caretPositions, //x,y of bottom of cursor position before each char, plus one after last char
          caretHeight, //height of cursor from bottom to top
          glyphColors, //color for each glyph, if color ranges supplied
          chunkedBounds, //total rects per (n=chunkedBoundsSize) consecutive glyphs
          ascender: ascender * fontSizeMult, //font ascender
          descender: descender * fontSizeMult, //font descender
          lineHeight, //computed line height
          topBaseline, //y coordinate of the top line's baseline
          blockBounds: [ //bounds for the whole block of text, including vertical padding for lineHeight
            anchorXOffset,
            anchorYOffset - lines.length * lineHeight,
            anchorXOffset + maxLineWidth,
            anchorYOffset
          ],
          visibleBounds, //total bounds of visible text paths, may be larger or smaller than totalBounds
          newGlyphSDFs: newGlyphs, //if this request included any new SDFs for the atlas, they'll be included here
          timings
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
      process(args, (result) => {
        const [x0, y0, x1, y1] = result.blockBounds;
        callback({
          width: x1 - x0,
          height: y1 - y0
        });
      }, {metricsOnly: true});
    }

    function parsePercent(str) {
      let match = str.match(/^([\d.]+)%$/);
      let pct = match ? parseFloat(match[1]) : NaN;
      return isNaN(pct) ? 0 : pct / 100
    }

    function now() {
      return (self.performance || Date).now()
    }

    // Array-backed structure for a single line's glyphs data
    function TextLine() {
      this.data = [];
    }
    const textLineProps = ['glyphObj', 'x', 'width', 'charIndex'];
    TextLine.prototype = {
      width: 0,
      isSoftWrapped: false,
      get count() {
        return Math.ceil(this.data.length / textLineProps.length)
      },
      glyphAt(i) {
        let fly = TextLine.flyweight;
        fly.data = this.data;
        fly.index = i;
        return fly
      },
      splitAt(i) {
        let newLine = new TextLine();
        newLine.data = this.data.splice(i * textLineProps.length);
        return newLine
      }
    };
    TextLine.flyweight = textLineProps.reduce((obj, prop, i, all) => {
      Object.defineProperty(obj, prop, {
        get() {
          return this.data[this.index * textLineProps.length + i]
        },
        set(val) {
          this.data[this.index * textLineProps.length + i] = val;
        }
      });
      return obj
    }, {data: null, index: 0});


    return {
      process,
      measure,
      loadFont
    }
  }

  /**
   * Index for performing fast spatial searches of a glyph's line segments.
   * @return {{addLineSegment:function, findNearestSignedDistance:function}}
   */
  function createGlyphSegmentsIndex() {
    let needsSort = false;
    const segments = [];

    function sortSegments() {
      if (needsSort) {
        // sort by maxX, this will let us short-circuit some loops below
        segments.sort(function(a, b) {
          return a.maxX - b.maxX
        });
        needsSort = false;
      }
    }

    /**
     * Add a line segment to the index.
     * @param x0
     * @param y0
     * @param x1
     * @param y1
     */
    function addLineSegment(x0, y0, x1, y1) {
      const segment = {
        x0, y0, x1, y1,
        minX: Math.min(x0, x1),
        minY: Math.min(y0, y1),
        maxX: Math.max(x0, x1),
        maxY: Math.max(y0, y1)
      };
      segments.push(segment);
      needsSort = true;
    }

    /**
     * For a given x/y, search the index for the closest line segment and return
     * its signed distance. Negative = inside, positive = outside, zero = on edge
     * @param x
     * @param y
     * @returns {number}
     */
    function findNearestSignedDistance(x, y) {
      sortSegments();
      let closestDistSq = Infinity;
      let closestDist = Infinity;

      for (let i = segments.length; i--;) {
        const seg = segments[i];
        if (seg.maxX + closestDist <= x) break //sorting by maxX means no more can be closer, so we can short-circuit
        if (x + closestDist > seg.minX && y - closestDist < seg.maxY && y + closestDist > seg.minY) {
          const distSq = absSquareDistanceToLineSegment(x, y, seg.x0, seg.y0, seg.x1, seg.y1);
          if (distSq < closestDistSq) {
            closestDistSq = distSq;
            closestDist = Math.sqrt(closestDistSq);
          }
        }
      }

      // Flip to negative distance if inside the poly
      if (isPointInPoly(x, y)) {
        closestDist = -closestDist;
      }
      return closestDist
    }

    // Determine whether the given point lies inside or outside the glyph. Uses a simple
    // ray casting algorithm using a ray pointing east from the point.
    function isPointInPoly(x, y) {
      sortSegments();
      let inside = false;
      for (let i = segments.length; i--;) {
        const seg = segments[i];
        if (seg.maxX <= x) break //sorting by maxX means no more can cross, so we can short-circuit
        if (seg.minY < y && seg.maxY > y) {
          const intersects = ((seg.y0 > y) !== (seg.y1 > y)) && (x < (seg.x1 - seg.x0) * (y - seg.y0) / (seg.y1 - seg.y0) + seg.x0);
          if (intersects) {
            inside = !inside;
          }
        }
      }
      return inside
    }

    // Find the absolute distance from a point to a line segment at closest approach
    function absSquareDistanceToLineSegment(x, y, lineX0, lineY0, lineX1, lineY1) {
      const ldx = lineX1 - lineX0;
      const ldy = lineY1 - lineY0;
      const lengthSq = ldx * ldx + ldy * ldy;
      const t = lengthSq ? Math.max(0, Math.min(1, ((x - lineX0) * ldx + (y - lineY0) * ldy) / lengthSq)) : 0;
      const dx = x - (lineX0 + t * ldx);
      const dy = y - (lineY0 + t * ldy);
      return dx * dx + dy * dy
    }

    return {
      addLineSegment,
      findNearestSignedDistance
    }
  }

  /*!
  Custom build of Typr.ts (https://github.com/fredli74/Typr.ts) for use in Troika text rendering.
  Original MIT license applies: https://github.com/fredli74/Typr.ts/blob/master/LICENSE
  */
  function typrFactory(){return "undefined"==typeof window&&(self.window=self),function(r){var e={parse:function(r){var t=e._bin,a=new Uint8Array(r);if("ttcf"==t.readASCII(a,0,4)){var n=4;t.readUshort(a,n),n+=2,t.readUshort(a,n),n+=2;var o=t.readUint(a,n);n+=4;for(var s=[],i=0;i<o;i++){var h=t.readUint(a,n);n+=4,s.push(e._readFont(a,h));}return s}return [e._readFont(a,0)]},_readFont:function(r,t){var a=e._bin,n=t;a.readFixed(r,t),t+=4;var o=a.readUshort(r,t);t+=2,a.readUshort(r,t),t+=2,a.readUshort(r,t),t+=2,a.readUshort(r,t),t+=2;for(var s=["cmap","head","hhea","maxp","hmtx","name","OS/2","post","loca","glyf","kern","CFF ","GPOS","GSUB","SVG "],i={_data:r,_offset:n},h={},f=0;f<o;f++){var d=a.readASCII(r,t,4);t+=4,a.readUint(r,t),t+=4;var u=a.readUint(r,t);t+=4;var l=a.readUint(r,t);t+=4,h[d]={offset:u,length:l};}for(f=0;f<s.length;f++){var v=s[f];h[v]&&(i[v.trim()]=e[v.trim()].parse(r,h[v].offset,h[v].length,i));}return i},_tabOffset:function(r,t,a){for(var n=e._bin,o=n.readUshort(r,a+4),s=a+12,i=0;i<o;i++){var h=n.readASCII(r,s,4);s+=4,n.readUint(r,s),s+=4;var f=n.readUint(r,s);if(s+=4,n.readUint(r,s),s+=4,h==t)return f}return 0}};e._bin={readFixed:function(r,e){return (r[e]<<8|r[e+1])+(r[e+2]<<8|r[e+3])/65540},readF2dot14:function(r,t){return e._bin.readShort(r,t)/16384},readInt:function(r,t){var a=e._bin.t.uint8;return a[0]=r[t+3],a[1]=r[t+2],a[2]=r[t+1],a[3]=r[t],e._bin.t.int32[0]},readInt8:function(r,t){return e._bin.t.uint8[0]=r[t],e._bin.t.int8[0]},readShort:function(r,t){var a=e._bin.t.uint8;return a[1]=r[t],a[0]=r[t+1],e._bin.t.int16[0]},readUshort:function(r,e){return r[e]<<8|r[e+1]},readUshorts:function(r,t,a){for(var n=[],o=0;o<a;o++)n.push(e._bin.readUshort(r,t+2*o));return n},readUint:function(r,t){var a=e._bin.t.uint8;return a[3]=r[t],a[2]=r[t+1],a[1]=r[t+2],a[0]=r[t+3],e._bin.t.uint32[0]},readUint64:function(r,t){return 4294967296*e._bin.readUint(r,t)+e._bin.readUint(r,t+4)},readASCII:function(r,e,t){for(var a="",n=0;n<t;n++)a+=String.fromCharCode(r[e+n]);return a},readUnicode:function(r,e,t){for(var a="",n=0;n<t;n++){var o=r[e++]<<8|r[e++];a+=String.fromCharCode(o);}return a},_tdec:"undefined"!=typeof window&&window.TextDecoder?new window.TextDecoder:null,readUTF8:function(r,t,a){var n=e._bin._tdec;return n&&0==t&&a==r.length?n.decode(r):e._bin.readASCII(r,t,a)},readBytes:function(r,e,t){for(var a=[],n=0;n<t;n++)a.push(r[e+n]);return a},readASCIIArray:function(r,e,t){for(var a=[],n=0;n<t;n++)a.push(String.fromCharCode(r[e+n]));return a}},e._bin.t={buff:new ArrayBuffer(8)},e._bin.t.int8=new Int8Array(e._bin.t.buff),e._bin.t.uint8=new Uint8Array(e._bin.t.buff),e._bin.t.int16=new Int16Array(e._bin.t.buff),e._bin.t.uint16=new Uint16Array(e._bin.t.buff),e._bin.t.int32=new Int32Array(e._bin.t.buff),e._bin.t.uint32=new Uint32Array(e._bin.t.buff),e._lctf={},e._lctf.parse=function(r,t,a,n,o){var s=e._bin,i={},h=t;s.readFixed(r,t),t+=4;var f=s.readUshort(r,t);t+=2;var d=s.readUshort(r,t);t+=2;var u=s.readUshort(r,t);return t+=2,i.scriptList=e._lctf.readScriptList(r,h+f),i.featureList=e._lctf.readFeatureList(r,h+d),i.lookupList=e._lctf.readLookupList(r,h+u,o),i},e._lctf.readLookupList=function(r,t,a){var n=e._bin,o=t,s=[],i=n.readUshort(r,t);t+=2;for(var h=0;h<i;h++){var f=n.readUshort(r,t);t+=2;var d=e._lctf.readLookupTable(r,o+f,a);s.push(d);}return s},e._lctf.readLookupTable=function(r,t,a){var n=e._bin,o=t,s={tabs:[]};s.ltype=n.readUshort(r,t),t+=2,s.flag=n.readUshort(r,t),t+=2;var i=n.readUshort(r,t);t+=2;for(var h=s.ltype,f=0;f<i;f++){var d=n.readUshort(r,t);t+=2;var u=a(r,h,o+d,s);s.tabs.push(u);}return s},e._lctf.numOfOnes=function(r){for(var e=0,t=0;t<32;t++)0!=(r>>>t&1)&&e++;return e},e._lctf.readClassDef=function(r,t){var a=e._bin,n=[],o=a.readUshort(r,t);if(t+=2,1==o){var s=a.readUshort(r,t);t+=2;var i=a.readUshort(r,t);t+=2;for(var h=0;h<i;h++)n.push(s+h),n.push(s+h),n.push(a.readUshort(r,t)),t+=2;}if(2==o){var f=a.readUshort(r,t);t+=2;for(h=0;h<f;h++)n.push(a.readUshort(r,t)),t+=2,n.push(a.readUshort(r,t)),t+=2,n.push(a.readUshort(r,t)),t+=2;}return n},e._lctf.getInterval=function(r,e){for(var t=0;t<r.length;t+=3){var a=r[t],n=r[t+1];if(r[t+2],a<=e&&e<=n)return t}return -1},e._lctf.readCoverage=function(r,t){var a=e._bin,n={};n.fmt=a.readUshort(r,t),t+=2;var o=a.readUshort(r,t);return t+=2,1==n.fmt&&(n.tab=a.readUshorts(r,t,o)),2==n.fmt&&(n.tab=a.readUshorts(r,t,3*o)),n},e._lctf.coverageIndex=function(r,t){var a=r.tab;if(1==r.fmt)return a.indexOf(t);if(2==r.fmt){var n=e._lctf.getInterval(a,t);if(-1!=n)return a[n+2]+(t-a[n])}return -1},e._lctf.readFeatureList=function(r,t){var a=e._bin,n=t,o=[],s=a.readUshort(r,t);t+=2;for(var i=0;i<s;i++){var h=a.readASCII(r,t,4);t+=4;var f=a.readUshort(r,t);t+=2;var d=e._lctf.readFeatureTable(r,n+f);d.tag=h.trim(),o.push(d);}return o},e._lctf.readFeatureTable=function(r,t){var a=e._bin,n=t,o={},s=a.readUshort(r,t);t+=2,s>0&&(o.featureParams=n+s);var i=a.readUshort(r,t);t+=2,o.tab=[];for(var h=0;h<i;h++)o.tab.push(a.readUshort(r,t+2*h));return o},e._lctf.readScriptList=function(r,t){var a=e._bin,n=t,o={},s=a.readUshort(r,t);t+=2;for(var i=0;i<s;i++){var h=a.readASCII(r,t,4);t+=4;var f=a.readUshort(r,t);t+=2,o[h.trim()]=e._lctf.readScriptTable(r,n+f);}return o},e._lctf.readScriptTable=function(r,t){var a=e._bin,n=t,o={},s=a.readUshort(r,t);t+=2,o.default=e._lctf.readLangSysTable(r,n+s);var i=a.readUshort(r,t);t+=2;for(var h=0;h<i;h++){var f=a.readASCII(r,t,4);t+=4;var d=a.readUshort(r,t);t+=2,o[f.trim()]=e._lctf.readLangSysTable(r,n+d);}return o},e._lctf.readLangSysTable=function(r,t){var a=e._bin,n={};a.readUshort(r,t),t+=2,n.reqFeature=a.readUshort(r,t),t+=2;var o=a.readUshort(r,t);return t+=2,n.features=a.readUshorts(r,t,o),n},e.CFF={},e.CFF.parse=function(r,t,a){var n=e._bin;(r=new Uint8Array(r.buffer,t,a))[t=0],r[++t],r[++t],r[++t],t++;var o=[];t=e.CFF.readIndex(r,t,o);for(var s=[],i=0;i<o.length-1;i++)s.push(n.readASCII(r,t+o[i],o[i+1]-o[i]));t+=o[o.length-1];var h=[];t=e.CFF.readIndex(r,t,h);var f=[];for(i=0;i<h.length-1;i++)f.push(e.CFF.readDict(r,t+h[i],t+h[i+1]));t+=h[h.length-1];var d=f[0],u=[];t=e.CFF.readIndex(r,t,u);var l=[];for(i=0;i<u.length-1;i++)l.push(n.readASCII(r,t+u[i],u[i+1]-u[i]));if(t+=u[u.length-1],e.CFF.readSubrs(r,t,d),d.CharStrings){t=d.CharStrings;u=[];t=e.CFF.readIndex(r,t,u);var v=[];for(i=0;i<u.length-1;i++)v.push(n.readBytes(r,t+u[i],u[i+1]-u[i]));d.CharStrings=v;}if(d.ROS){t=d.FDArray;var c=[];t=e.CFF.readIndex(r,t,c),d.FDArray=[];for(i=0;i<c.length-1;i++){var p=e.CFF.readDict(r,t+c[i],t+c[i+1]);e.CFF._readFDict(r,p,l),d.FDArray.push(p);}t+=c[c.length-1],t=d.FDSelect,d.FDSelect=[];var U=r[t];if(t++,3!=U)throw U;var g=n.readUshort(r,t);t+=2;for(i=0;i<g+1;i++)d.FDSelect.push(n.readUshort(r,t),r[t+2]),t+=3;}return d.Encoding&&(d.Encoding=e.CFF.readEncoding(r,d.Encoding,d.CharStrings.length)),d.charset&&(d.charset=e.CFF.readCharset(r,d.charset,d.CharStrings.length)),e.CFF._readFDict(r,d,l),d},e.CFF._readFDict=function(r,t,a){var n;for(var o in t.Private&&(n=t.Private[1],t.Private=e.CFF.readDict(r,n,n+t.Private[0]),t.Private.Subrs&&e.CFF.readSubrs(r,n+t.Private.Subrs,t.Private)),t)-1!=["FamilyName","FontName","FullName","Notice","version","Copyright"].indexOf(o)&&(t[o]=a[t[o]-426+35]);},e.CFF.readSubrs=function(r,t,a){var n=e._bin,o=[];t=e.CFF.readIndex(r,t,o);var s,i=o.length;s=i<1240?107:i<33900?1131:32768,a.Bias=s,a.Subrs=[];for(var h=0;h<o.length-1;h++)a.Subrs.push(n.readBytes(r,t+o[h],o[h+1]-o[h]));},e.CFF.tableSE=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,0,111,112,113,114,0,115,116,117,118,119,120,121,122,0,123,0,124,125,126,127,128,129,130,131,0,132,133,0,134,135,136,137,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,138,0,139,0,0,0,0,140,141,142,143,0,0,0,0,0,144,0,0,0,145,0,0,146,147,148,149,0,0,0,0],e.CFF.glyphByUnicode=function(r,e){for(var t=0;t<r.charset.length;t++)if(r.charset[t]==e)return t;return -1},e.CFF.glyphBySE=function(r,t){return t<0||t>255?-1:e.CFF.glyphByUnicode(r,e.CFF.tableSE[t])},e.CFF.readEncoding=function(r,t,a){e._bin;var n=[".notdef"],o=r[t];if(t++,0!=o)throw "error: unknown encoding format: "+o;var s=r[t];t++;for(var i=0;i<s;i++)n.push(r[t+i]);return n},e.CFF.readCharset=function(r,t,a){var n=e._bin,o=[".notdef"],s=r[t];if(t++,0==s)for(var i=0;i<a;i++){var h=n.readUshort(r,t);t+=2,o.push(h);}else {if(1!=s&&2!=s)throw "error: format: "+s;for(;o.length<a;){h=n.readUshort(r,t);t+=2;var f=0;1==s?(f=r[t],t++):(f=n.readUshort(r,t),t+=2);for(i=0;i<=f;i++)o.push(h),h++;}}return o},e.CFF.readIndex=function(r,t,a){var n=e._bin,o=n.readUshort(r,t)+1,s=r[t+=2];if(t++,1==s)for(var i=0;i<o;i++)a.push(r[t+i]);else if(2==s)for(i=0;i<o;i++)a.push(n.readUshort(r,t+2*i));else if(3==s)for(i=0;i<o;i++)a.push(16777215&n.readUint(r,t+3*i-1));else if(1!=o)throw "unsupported offset size: "+s+", count: "+o;return (t+=o*s)-1},e.CFF.getCharString=function(r,t,a){var n=e._bin,o=r[t],s=r[t+1];r[t+2],r[t+3],r[t+4];var i=1,h=null,f=null;o<=20&&(h=o,i=1),12==o&&(h=100*o+s,i=2),21<=o&&o<=27&&(h=o,i=1),28==o&&(f=n.readShort(r,t+1),i=3),29<=o&&o<=31&&(h=o,i=1),32<=o&&o<=246&&(f=o-139,i=1),247<=o&&o<=250&&(f=256*(o-247)+s+108,i=2),251<=o&&o<=254&&(f=256*-(o-251)-s-108,i=2),255==o&&(f=n.readInt(r,t+1)/65535,i=5),a.val=null!=f?f:"o"+h,a.size=i;},e.CFF.readCharString=function(r,t,a){for(var n=t+a,o=e._bin,s=[];t<n;){var i=r[t],h=r[t+1];r[t+2],r[t+3],r[t+4];var f=1,d=null,u=null;i<=20&&(d=i,f=1),12==i&&(d=100*i+h,f=2),19!=i&&20!=i||(d=i,f=2),21<=i&&i<=27&&(d=i,f=1),28==i&&(u=o.readShort(r,t+1),f=3),29<=i&&i<=31&&(d=i,f=1),32<=i&&i<=246&&(u=i-139,f=1),247<=i&&i<=250&&(u=256*(i-247)+h+108,f=2),251<=i&&i<=254&&(u=256*-(i-251)-h-108,f=2),255==i&&(u=o.readInt(r,t+1)/65535,f=5),s.push(null!=u?u:"o"+d),t+=f;}return s},e.CFF.readDict=function(r,t,a){for(var n=e._bin,o={},s=[];t<a;){var i=r[t],h=r[t+1];r[t+2],r[t+3],r[t+4];var f=1,d=null,u=null;if(28==i&&(u=n.readShort(r,t+1),f=3),29==i&&(u=n.readInt(r,t+1),f=5),32<=i&&i<=246&&(u=i-139,f=1),247<=i&&i<=250&&(u=256*(i-247)+h+108,f=2),251<=i&&i<=254&&(u=256*-(i-251)-h-108,f=2),255==i)throw u=n.readInt(r,t+1)/65535,f=5,"unknown number";if(30==i){var l=[];for(f=1;;){var v=r[t+f];f++;var c=v>>4,p=15&v;if(15!=c&&l.push(c),15!=p&&l.push(p),15==p)break}for(var U="",g=[0,1,2,3,4,5,6,7,8,9,".","e","e-","reserved","-","endOfNumber"],S=0;S<l.length;S++)U+=g[l[S]];u=parseFloat(U);}if(i<=21)if(d=["version","Notice","FullName","FamilyName","Weight","FontBBox","BlueValues","OtherBlues","FamilyBlues","FamilyOtherBlues","StdHW","StdVW","escape","UniqueID","XUID","charset","Encoding","CharStrings","Private","Subrs","defaultWidthX","nominalWidthX"][i],f=1,12==i)d=["Copyright","isFixedPitch","ItalicAngle","UnderlinePosition","UnderlineThickness","PaintType","CharstringType","FontMatrix","StrokeWidth","BlueScale","BlueShift","BlueFuzz","StemSnapH","StemSnapV","ForceBold",0,0,"LanguageGroup","ExpansionFactor","initialRandomSeed","SyntheticBase","PostScript","BaseFontName","BaseFontBlend",0,0,0,0,0,0,"ROS","CIDFontVersion","CIDFontRevision","CIDFontType","CIDCount","UIDBase","FDArray","FDSelect","FontName"][h],f=2;null!=d?(o[d]=1==s.length?s[0]:s,s=[]):s.push(u),t+=f;}return o},e.cmap={},e.cmap.parse=function(r,t,a){r=new Uint8Array(r.buffer,t,a),t=0;var n=e._bin,o={};n.readUshort(r,t),t+=2;var s=n.readUshort(r,t);t+=2;var i=[];o.tables=[];for(var h=0;h<s;h++){var f=n.readUshort(r,t);t+=2;var d=n.readUshort(r,t);t+=2;var u=n.readUint(r,t);t+=4;var l="p"+f+"e"+d,v=i.indexOf(u);if(-1==v){var c;v=o.tables.length,i.push(u);var p=n.readUshort(r,u);0==p?c=e.cmap.parse0(r,u):4==p?c=e.cmap.parse4(r,u):6==p?c=e.cmap.parse6(r,u):12==p?c=e.cmap.parse12(r,u):console.debug("unknown format: "+p,f,d,u),o.tables.push(c);}if(null!=o[l])throw "multiple tables for one platform+encoding";o[l]=v;}return o},e.cmap.parse0=function(r,t){var a=e._bin,n={};n.format=a.readUshort(r,t),t+=2;var o=a.readUshort(r,t);t+=2,a.readUshort(r,t),t+=2,n.map=[];for(var s=0;s<o-6;s++)n.map.push(r[t+s]);return n},e.cmap.parse4=function(r,t){var a=e._bin,n=t,o={};o.format=a.readUshort(r,t),t+=2;var s=a.readUshort(r,t);t+=2,a.readUshort(r,t),t+=2;var i=a.readUshort(r,t);t+=2;var h=i/2;o.searchRange=a.readUshort(r,t),t+=2,o.entrySelector=a.readUshort(r,t),t+=2,o.rangeShift=a.readUshort(r,t),t+=2,o.endCount=a.readUshorts(r,t,h),t+=2*h,t+=2,o.startCount=a.readUshorts(r,t,h),t+=2*h,o.idDelta=[];for(var f=0;f<h;f++)o.idDelta.push(a.readShort(r,t)),t+=2;for(o.idRangeOffset=a.readUshorts(r,t,h),t+=2*h,o.glyphIdArray=[];t<n+s;)o.glyphIdArray.push(a.readUshort(r,t)),t+=2;return o},e.cmap.parse6=function(r,t){var a=e._bin,n={};n.format=a.readUshort(r,t),t+=2,a.readUshort(r,t),t+=2,a.readUshort(r,t),t+=2,n.firstCode=a.readUshort(r,t),t+=2;var o=a.readUshort(r,t);t+=2,n.glyphIdArray=[];for(var s=0;s<o;s++)n.glyphIdArray.push(a.readUshort(r,t)),t+=2;return n},e.cmap.parse12=function(r,t){var a=e._bin,n={};n.format=a.readUshort(r,t),t+=2,t+=2,a.readUint(r,t),t+=4,a.readUint(r,t),t+=4;var o=a.readUint(r,t);t+=4,n.groups=[];for(var s=0;s<o;s++){var i=t+12*s,h=a.readUint(r,i+0),f=a.readUint(r,i+4),d=a.readUint(r,i+8);n.groups.push([h,f,d]);}return n},e.glyf={},e.glyf.parse=function(r,e,t,a){for(var n=[],o=0;o<a.maxp.numGlyphs;o++)n.push(null);return n},e.glyf._parseGlyf=function(r,t){var a=e._bin,n=r._data,o=e._tabOffset(n,"glyf",r._offset)+r.loca[t];if(r.loca[t]==r.loca[t+1])return null;var s={};if(s.noc=a.readShort(n,o),o+=2,s.xMin=a.readShort(n,o),o+=2,s.yMin=a.readShort(n,o),o+=2,s.xMax=a.readShort(n,o),o+=2,s.yMax=a.readShort(n,o),o+=2,s.xMin>=s.xMax||s.yMin>=s.yMax)return null;if(s.noc>0){s.endPts=[];for(var i=0;i<s.noc;i++)s.endPts.push(a.readUshort(n,o)),o+=2;var h=a.readUshort(n,o);if(o+=2,n.length-o<h)return null;s.instructions=a.readBytes(n,o,h),o+=h;var f=s.endPts[s.noc-1]+1;s.flags=[];for(i=0;i<f;i++){var d=n[o];if(o++,s.flags.push(d),0!=(8&d)){var u=n[o];o++;for(var l=0;l<u;l++)s.flags.push(d),i++;}}s.xs=[];for(i=0;i<f;i++){var v=0!=(2&s.flags[i]),c=0!=(16&s.flags[i]);v?(s.xs.push(c?n[o]:-n[o]),o++):c?s.xs.push(0):(s.xs.push(a.readShort(n,o)),o+=2);}s.ys=[];for(i=0;i<f;i++){v=0!=(4&s.flags[i]),c=0!=(32&s.flags[i]);v?(s.ys.push(c?n[o]:-n[o]),o++):c?s.ys.push(0):(s.ys.push(a.readShort(n,o)),o+=2);}var p=0,U=0;for(i=0;i<f;i++)p+=s.xs[i],U+=s.ys[i],s.xs[i]=p,s.ys[i]=U;}else {var g;s.parts=[];do{g=a.readUshort(n,o),o+=2;var S={m:{a:1,b:0,c:0,d:1,tx:0,ty:0},p1:-1,p2:-1};if(s.parts.push(S),S.glyphIndex=a.readUshort(n,o),o+=2,1&g){var m=a.readShort(n,o);o+=2;var b=a.readShort(n,o);o+=2;}else {m=a.readInt8(n,o);o++;b=a.readInt8(n,o);o++;}2&g?(S.m.tx=m,S.m.ty=b):(S.p1=m,S.p2=b),8&g?(S.m.a=S.m.d=a.readF2dot14(n,o),o+=2):64&g?(S.m.a=a.readF2dot14(n,o),o+=2,S.m.d=a.readF2dot14(n,o),o+=2):128&g&&(S.m.a=a.readF2dot14(n,o),o+=2,S.m.b=a.readF2dot14(n,o),o+=2,S.m.c=a.readF2dot14(n,o),o+=2,S.m.d=a.readF2dot14(n,o),o+=2);}while(32&g);if(256&g){var y=a.readUshort(n,o);o+=2,s.instr=[];for(i=0;i<y;i++)s.instr.push(n[o]),o++;}}return s},e.GPOS={},e.GPOS.parse=function(r,t,a,n){return e._lctf.parse(r,t,a,n,e.GPOS.subt)},e.GPOS.subt=function(r,t,a,n){var o=e._bin,s=a,i={};if(i.fmt=o.readUshort(r,a),a+=2,1==t||2==t||3==t||7==t||8==t&&i.fmt<=2){var h=o.readUshort(r,a);a+=2,i.coverage=e._lctf.readCoverage(r,h+s);}if(1==t&&1==i.fmt){var f=o.readUshort(r,a);a+=2;var d=e._lctf.numOfOnes(f);0!=f&&(i.pos=e.GPOS.readValueRecord(r,a,f));}else if(2==t&&i.fmt>=1&&i.fmt<=2){f=o.readUshort(r,a);a+=2;var u=o.readUshort(r,a);a+=2;d=e._lctf.numOfOnes(f);var l=e._lctf.numOfOnes(u);if(1==i.fmt){i.pairsets=[];var v=o.readUshort(r,a);a+=2;for(var c=0;c<v;c++){var p=s+o.readUshort(r,a);a+=2;var U=o.readUshort(r,p);p+=2;for(var g=[],S=0;S<U;S++){var m=o.readUshort(r,p);p+=2,0!=f&&(x=e.GPOS.readValueRecord(r,p,f),p+=2*d),0!=u&&(P=e.GPOS.readValueRecord(r,p,u),p+=2*l),g.push({gid2:m,val1:x,val2:P});}i.pairsets.push(g);}}if(2==i.fmt){var b=o.readUshort(r,a);a+=2;var y=o.readUshort(r,a);a+=2;var F=o.readUshort(r,a);a+=2;var _=o.readUshort(r,a);a+=2,i.classDef1=e._lctf.readClassDef(r,s+b),i.classDef2=e._lctf.readClassDef(r,s+y),i.matrix=[];for(c=0;c<F;c++){var C=[];for(S=0;S<_;S++){var x=null,P=null;0!=f&&(x=e.GPOS.readValueRecord(r,a,f),a+=2*d),0!=u&&(P=e.GPOS.readValueRecord(r,a,u),a+=2*l),C.push({val1:x,val2:P});}i.matrix.push(C);}}}else {if(9==t&&1==i.fmt){var I=o.readUshort(r,a);a+=2;var w=o.readUint(r,a);if(a+=4,9==n.ltype)n.ltype=I;else if(n.ltype!=I)throw "invalid extension substitution";return e.GPOS.subt(r,n.ltype,s+w)}console.debug("unsupported GPOS table LookupType",t,"format",i.fmt);}return i},e.GPOS.readValueRecord=function(r,t,a){var n=e._bin,o=[];return o.push(1&a?n.readShort(r,t):0),t+=1&a?2:0,o.push(2&a?n.readShort(r,t):0),t+=2&a?2:0,o.push(4&a?n.readShort(r,t):0),t+=4&a?2:0,o.push(8&a?n.readShort(r,t):0),t+=8&a?2:0,o},e.GSUB={},e.GSUB.parse=function(r,t,a,n){return e._lctf.parse(r,t,a,n,e.GSUB.subt)},e.GSUB.subt=function(r,t,a,n){var o=e._bin,s=a,i={};if(i.fmt=o.readUshort(r,a),a+=2,1!=t&&4!=t&&5!=t&&6!=t)return null;if(1==t||4==t||5==t&&i.fmt<=2||6==t&&i.fmt<=2){var h=o.readUshort(r,a);a+=2,i.coverage=e._lctf.readCoverage(r,s+h);}if(1==t&&i.fmt>=1&&i.fmt<=2){if(1==i.fmt)i.delta=o.readShort(r,a),a+=2;else if(2==i.fmt){var f=o.readUshort(r,a);a+=2,i.newg=o.readUshorts(r,a,f),a+=2*i.newg.length;}}else if(4==t){i.vals=[];f=o.readUshort(r,a);a+=2;for(var d=0;d<f;d++){var u=o.readUshort(r,a);a+=2,i.vals.push(e.GSUB.readLigatureSet(r,s+u));}}else if(5==t&&2==i.fmt){if(2==i.fmt){var l=o.readUshort(r,a);a+=2,i.cDef=e._lctf.readClassDef(r,s+l),i.scset=[];var v=o.readUshort(r,a);a+=2;for(d=0;d<v;d++){var c=o.readUshort(r,a);a+=2,i.scset.push(0==c?null:e.GSUB.readSubClassSet(r,s+c));}}}else if(6==t&&3==i.fmt){if(3==i.fmt){for(d=0;d<3;d++){f=o.readUshort(r,a);a+=2;for(var p=[],U=0;U<f;U++)p.push(e._lctf.readCoverage(r,s+o.readUshort(r,a+2*U)));a+=2*f,0==d&&(i.backCvg=p),1==d&&(i.inptCvg=p),2==d&&(i.ahedCvg=p);}f=o.readUshort(r,a);a+=2,i.lookupRec=e.GSUB.readSubstLookupRecords(r,a,f);}}else {if(7==t&&1==i.fmt){var g=o.readUshort(r,a);a+=2;var S=o.readUint(r,a);if(a+=4,9==n.ltype)n.ltype=g;else if(n.ltype!=g)throw "invalid extension substitution";return e.GSUB.subt(r,n.ltype,s+S)}console.debug("unsupported GSUB table LookupType",t,"format",i.fmt);}return i},e.GSUB.readSubClassSet=function(r,t){var a=e._bin.readUshort,n=t,o=[],s=a(r,t);t+=2;for(var i=0;i<s;i++){var h=a(r,t);t+=2,o.push(e.GSUB.readSubClassRule(r,n+h));}return o},e.GSUB.readSubClassRule=function(r,t){var a=e._bin.readUshort,n={},o=a(r,t),s=a(r,t+=2);t+=2,n.input=[];for(var i=0;i<o-1;i++)n.input.push(a(r,t)),t+=2;return n.substLookupRecords=e.GSUB.readSubstLookupRecords(r,t,s),n},e.GSUB.readSubstLookupRecords=function(r,t,a){for(var n=e._bin.readUshort,o=[],s=0;s<a;s++)o.push(n(r,t),n(r,t+2)),t+=4;return o},e.GSUB.readChainSubClassSet=function(r,t){var a=e._bin,n=t,o=[],s=a.readUshort(r,t);t+=2;for(var i=0;i<s;i++){var h=a.readUshort(r,t);t+=2,o.push(e.GSUB.readChainSubClassRule(r,n+h));}return o},e.GSUB.readChainSubClassRule=function(r,t){for(var a=e._bin,n={},o=["backtrack","input","lookahead"],s=0;s<o.length;s++){var i=a.readUshort(r,t);t+=2,1==s&&i--,n[o[s]]=a.readUshorts(r,t,i),t+=2*n[o[s]].length;}i=a.readUshort(r,t);return t+=2,n.subst=a.readUshorts(r,t,2*i),t+=2*n.subst.length,n},e.GSUB.readLigatureSet=function(r,t){var a=e._bin,n=t,o=[],s=a.readUshort(r,t);t+=2;for(var i=0;i<s;i++){var h=a.readUshort(r,t);t+=2,o.push(e.GSUB.readLigature(r,n+h));}return o},e.GSUB.readLigature=function(r,t){var a=e._bin,n={chain:[]};n.nglyph=a.readUshort(r,t),t+=2;var o=a.readUshort(r,t);t+=2;for(var s=0;s<o-1;s++)n.chain.push(a.readUshort(r,t)),t+=2;return n},e.head={},e.head.parse=function(r,t,a){var n=e._bin,o={};return n.readFixed(r,t),t+=4,o.fontRevision=n.readFixed(r,t),t+=4,n.readUint(r,t),t+=4,n.readUint(r,t),t+=4,o.flags=n.readUshort(r,t),t+=2,o.unitsPerEm=n.readUshort(r,t),t+=2,o.created=n.readUint64(r,t),t+=8,o.modified=n.readUint64(r,t),t+=8,o.xMin=n.readShort(r,t),t+=2,o.yMin=n.readShort(r,t),t+=2,o.xMax=n.readShort(r,t),t+=2,o.yMax=n.readShort(r,t),t+=2,o.macStyle=n.readUshort(r,t),t+=2,o.lowestRecPPEM=n.readUshort(r,t),t+=2,o.fontDirectionHint=n.readShort(r,t),t+=2,o.indexToLocFormat=n.readShort(r,t),t+=2,o.glyphDataFormat=n.readShort(r,t),t+=2,o},e.hhea={},e.hhea.parse=function(r,t,a){var n=e._bin,o={};return n.readFixed(r,t),t+=4,o.ascender=n.readShort(r,t),t+=2,o.descender=n.readShort(r,t),t+=2,o.lineGap=n.readShort(r,t),t+=2,o.advanceWidthMax=n.readUshort(r,t),t+=2,o.minLeftSideBearing=n.readShort(r,t),t+=2,o.minRightSideBearing=n.readShort(r,t),t+=2,o.xMaxExtent=n.readShort(r,t),t+=2,o.caretSlopeRise=n.readShort(r,t),t+=2,o.caretSlopeRun=n.readShort(r,t),t+=2,o.caretOffset=n.readShort(r,t),t+=2,t+=8,o.metricDataFormat=n.readShort(r,t),t+=2,o.numberOfHMetrics=n.readUshort(r,t),t+=2,o},e.hmtx={},e.hmtx.parse=function(r,t,a,n){for(var o=e._bin,s={aWidth:[],lsBearing:[]},i=0,h=0,f=0;f<n.maxp.numGlyphs;f++)f<n.hhea.numberOfHMetrics&&(i=o.readUshort(r,t),t+=2,h=o.readShort(r,t),t+=2),s.aWidth.push(i),s.lsBearing.push(h);return s},e.kern={},e.kern.parse=function(r,t,a,n){var o=e._bin,s=o.readUshort(r,t);if(t+=2,1==s)return e.kern.parseV1(r,t-2,a,n);var i=o.readUshort(r,t);t+=2;for(var h={glyph1:[],rval:[]},f=0;f<i;f++){t+=2;a=o.readUshort(r,t);t+=2;var d=o.readUshort(r,t);t+=2;var u=d>>>8;if(0!=(u&=15))throw "unknown kern table format: "+u;t=e.kern.readFormat0(r,t,h);}return h},e.kern.parseV1=function(r,t,a,n){var o=e._bin;o.readFixed(r,t),t+=4;var s=o.readUint(r,t);t+=4;for(var i={glyph1:[],rval:[]},h=0;h<s;h++){o.readUint(r,t),t+=4;var f=o.readUshort(r,t);t+=2,o.readUshort(r,t),t+=2;var d=f>>>8;if(0!=(d&=15))throw "unknown kern table format: "+d;t=e.kern.readFormat0(r,t,i);}return i},e.kern.readFormat0=function(r,t,a){var n=e._bin,o=-1,s=n.readUshort(r,t);t+=2,n.readUshort(r,t),t+=2,n.readUshort(r,t),t+=2,n.readUshort(r,t),t+=2;for(var i=0;i<s;i++){var h=n.readUshort(r,t);t+=2;var f=n.readUshort(r,t);t+=2;var d=n.readShort(r,t);t+=2,h!=o&&(a.glyph1.push(h),a.rval.push({glyph2:[],vals:[]}));var u=a.rval[a.rval.length-1];u.glyph2.push(f),u.vals.push(d),o=h;}return t},e.loca={},e.loca.parse=function(r,t,a,n){var o=e._bin,s=[],i=n.head.indexToLocFormat,h=n.maxp.numGlyphs+1;if(0==i)for(var f=0;f<h;f++)s.push(o.readUshort(r,t+(f<<1))<<1);if(1==i)for(f=0;f<h;f++)s.push(o.readUint(r,t+(f<<2)));return s},e.maxp={},e.maxp.parse=function(r,t,a){var n=e._bin,o={},s=n.readUint(r,t);return t+=4,o.numGlyphs=n.readUshort(r,t),t+=2,65536==s&&(o.maxPoints=n.readUshort(r,t),t+=2,o.maxContours=n.readUshort(r,t),t+=2,o.maxCompositePoints=n.readUshort(r,t),t+=2,o.maxCompositeContours=n.readUshort(r,t),t+=2,o.maxZones=n.readUshort(r,t),t+=2,o.maxTwilightPoints=n.readUshort(r,t),t+=2,o.maxStorage=n.readUshort(r,t),t+=2,o.maxFunctionDefs=n.readUshort(r,t),t+=2,o.maxInstructionDefs=n.readUshort(r,t),t+=2,o.maxStackElements=n.readUshort(r,t),t+=2,o.maxSizeOfInstructions=n.readUshort(r,t),t+=2,o.maxComponentElements=n.readUshort(r,t),t+=2,o.maxComponentDepth=n.readUshort(r,t),t+=2),o},e.name={},e.name.parse=function(r,t,a){var n=e._bin,o={};n.readUshort(r,t),t+=2;var s=n.readUshort(r,t);t+=2,n.readUshort(r,t);for(var i,h=["copyright","fontFamily","fontSubfamily","ID","fullName","version","postScriptName","trademark","manufacturer","designer","description","urlVendor","urlDesigner","licence","licenceURL","---","typoFamilyName","typoSubfamilyName","compatibleFull","sampleText","postScriptCID","wwsFamilyName","wwsSubfamilyName","lightPalette","darkPalette"],f=t+=2,d=0;d<s;d++){var u=n.readUshort(r,t);t+=2;var l=n.readUshort(r,t);t+=2;var v=n.readUshort(r,t);t+=2;var c=n.readUshort(r,t);t+=2;var p=n.readUshort(r,t);t+=2;var U=n.readUshort(r,t);t+=2;var g,S=h[c],m=f+12*s+U;if(0==u)g=n.readUnicode(r,m,p/2);else if(3==u&&0==l)g=n.readUnicode(r,m,p/2);else if(0==l)g=n.readASCII(r,m,p);else if(1==l)g=n.readUnicode(r,m,p/2);else if(3==l)g=n.readUnicode(r,m,p/2);else {if(1!=u)throw "unknown encoding "+l+", platformID: "+u;g=n.readASCII(r,m,p),console.debug("reading unknown MAC encoding "+l+" as ASCII");}var b="p"+u+","+v.toString(16);null==o[b]&&(o[b]={}),o[b][void 0!==S?S:c]=g,o[b]._lang=v;}for(var y in o)if(null!=o[y].postScriptName&&1033==o[y]._lang)return o[y];for(var y in o)if(null!=o[y].postScriptName&&0==o[y]._lang)return o[y];for(var y in o)if(null!=o[y].postScriptName&&3084==o[y]._lang)return o[y];for(var y in o)if(null!=o[y].postScriptName)return o[y];for(var y in o){i=y;break}return console.debug("returning name table with languageID "+o[i]._lang),o[i]},e["OS/2"]={},e["OS/2"].parse=function(r,t,a){var n=e._bin.readUshort(r,t);t+=2;var o={};if(0==n)e["OS/2"].version0(r,t,o);else if(1==n)e["OS/2"].version1(r,t,o);else if(2==n||3==n||4==n)e["OS/2"].version2(r,t,o);else {if(5!=n)throw "unknown OS/2 table version: "+n;e["OS/2"].version5(r,t,o);}return o},e["OS/2"].version0=function(r,t,a){var n=e._bin;return a.xAvgCharWidth=n.readShort(r,t),t+=2,a.usWeightClass=n.readUshort(r,t),t+=2,a.usWidthClass=n.readUshort(r,t),t+=2,a.fsType=n.readUshort(r,t),t+=2,a.ySubscriptXSize=n.readShort(r,t),t+=2,a.ySubscriptYSize=n.readShort(r,t),t+=2,a.ySubscriptXOffset=n.readShort(r,t),t+=2,a.ySubscriptYOffset=n.readShort(r,t),t+=2,a.ySuperscriptXSize=n.readShort(r,t),t+=2,a.ySuperscriptYSize=n.readShort(r,t),t+=2,a.ySuperscriptXOffset=n.readShort(r,t),t+=2,a.ySuperscriptYOffset=n.readShort(r,t),t+=2,a.yStrikeoutSize=n.readShort(r,t),t+=2,a.yStrikeoutPosition=n.readShort(r,t),t+=2,a.sFamilyClass=n.readShort(r,t),t+=2,a.panose=n.readBytes(r,t,10),t+=10,a.ulUnicodeRange1=n.readUint(r,t),t+=4,a.ulUnicodeRange2=n.readUint(r,t),t+=4,a.ulUnicodeRange3=n.readUint(r,t),t+=4,a.ulUnicodeRange4=n.readUint(r,t),t+=4,a.achVendID=[n.readInt8(r,t),n.readInt8(r,t+1),n.readInt8(r,t+2),n.readInt8(r,t+3)],t+=4,a.fsSelection=n.readUshort(r,t),t+=2,a.usFirstCharIndex=n.readUshort(r,t),t+=2,a.usLastCharIndex=n.readUshort(r,t),t+=2,a.sTypoAscender=n.readShort(r,t),t+=2,a.sTypoDescender=n.readShort(r,t),t+=2,a.sTypoLineGap=n.readShort(r,t),t+=2,a.usWinAscent=n.readUshort(r,t),t+=2,a.usWinDescent=n.readUshort(r,t),t+=2},e["OS/2"].version1=function(r,t,a){var n=e._bin;return t=e["OS/2"].version0(r,t,a),a.ulCodePageRange1=n.readUint(r,t),t+=4,a.ulCodePageRange2=n.readUint(r,t),t+=4},e["OS/2"].version2=function(r,t,a){var n=e._bin;return t=e["OS/2"].version1(r,t,a),a.sxHeight=n.readShort(r,t),t+=2,a.sCapHeight=n.readShort(r,t),t+=2,a.usDefault=n.readUshort(r,t),t+=2,a.usBreak=n.readUshort(r,t),t+=2,a.usMaxContext=n.readUshort(r,t),t+=2},e["OS/2"].version5=function(r,t,a){var n=e._bin;return t=e["OS/2"].version2(r,t,a),a.usLowerOpticalPointSize=n.readUshort(r,t),t+=2,a.usUpperOpticalPointSize=n.readUshort(r,t),t+=2},e.post={},e.post.parse=function(r,t,a){var n=e._bin,o={};return o.version=n.readFixed(r,t),t+=4,o.italicAngle=n.readFixed(r,t),t+=4,o.underlinePosition=n.readShort(r,t),t+=2,o.underlineThickness=n.readShort(r,t),t+=2,o},null==e&&(e={}),null==e.U&&(e.U={}),e.U.codeToGlyph=function(r,e){var t=r.cmap,a=-1;if(null!=t.p0e4?a=t.p0e4:null!=t.p3e1?a=t.p3e1:null!=t.p1e0?a=t.p1e0:null!=t.p0e3&&(a=t.p0e3),-1==a)throw "no familiar platform and encoding!";var n=t.tables[a];if(0==n.format)return e>=n.map.length?0:n.map[e];if(4==n.format){for(var o=-1,s=0;s<n.endCount.length;s++)if(e<=n.endCount[s]){o=s;break}if(-1==o)return 0;if(n.startCount[o]>e)return 0;return 65535&(0!=n.idRangeOffset[o]?n.glyphIdArray[e-n.startCount[o]+(n.idRangeOffset[o]>>1)-(n.idRangeOffset.length-o)]:e+n.idDelta[o])}if(12==n.format){if(e>n.groups[n.groups.length-1][1])return 0;for(s=0;s<n.groups.length;s++){var i=n.groups[s];if(i[0]<=e&&e<=i[1])return i[2]+(e-i[0])}return 0}throw "unknown cmap table format "+n.format},e.U.glyphToPath=function(r,t){var a={cmds:[],crds:[]};if(r.SVG&&r.SVG.entries[t]){var n=r.SVG.entries[t];return null==n?a:("string"==typeof n&&(n=e.SVG.toPath(n),r.SVG.entries[t]=n),n)}if(r.CFF){var o={x:0,y:0,stack:[],nStems:0,haveWidth:!1,width:r.CFF.Private?r.CFF.Private.defaultWidthX:0,open:!1},s=r.CFF,i=r.CFF.Private;if(s.ROS){for(var h=0;s.FDSelect[h+2]<=t;)h+=2;i=s.FDArray[s.FDSelect[h+1]].Private;}e.U._drawCFF(r.CFF.CharStrings[t],o,s,i,a);}else r.glyf&&e.U._drawGlyf(t,r,a);return a},e.U._drawGlyf=function(r,t,a){var n=t.glyf[r];null==n&&(n=t.glyf[r]=e.glyf._parseGlyf(t,r)),null!=n&&(n.noc>-1?e.U._simpleGlyph(n,a):e.U._compoGlyph(n,t,a));},e.U._simpleGlyph=function(r,t){for(var a=0;a<r.noc;a++){for(var n=0==a?0:r.endPts[a-1]+1,o=r.endPts[a],s=n;s<=o;s++){var i=s==n?o:s-1,h=s==o?n:s+1,f=1&r.flags[s],d=1&r.flags[i],u=1&r.flags[h],l=r.xs[s],v=r.ys[s];if(s==n)if(f){if(!d){e.U.P.moveTo(t,l,v);continue}e.U.P.moveTo(t,r.xs[i],r.ys[i]);}else d?e.U.P.moveTo(t,r.xs[i],r.ys[i]):e.U.P.moveTo(t,(r.xs[i]+l)/2,(r.ys[i]+v)/2);f?d&&e.U.P.lineTo(t,l,v):u?e.U.P.qcurveTo(t,l,v,r.xs[h],r.ys[h]):e.U.P.qcurveTo(t,l,v,(l+r.xs[h])/2,(v+r.ys[h])/2);}e.U.P.closePath(t);}},e.U._compoGlyph=function(r,t,a){for(var n=0;n<r.parts.length;n++){var o={cmds:[],crds:[]},s=r.parts[n];e.U._drawGlyf(s.glyphIndex,t,o);for(var i=s.m,h=0;h<o.crds.length;h+=2){var f=o.crds[h],d=o.crds[h+1];a.crds.push(f*i.a+d*i.b+i.tx),a.crds.push(f*i.c+d*i.d+i.ty);}for(h=0;h<o.cmds.length;h++)a.cmds.push(o.cmds[h]);}},e.U._getGlyphClass=function(r,t){var a=e._lctf.getInterval(t,r);return -1==a?0:t[a+2]},e.U.getPairAdjustment=function(r,t,a){var n=0;if(r.GPOS)for(var o=r.GPOS,s=o.lookupList,i=o.featureList,h=[],f=0;f<i.length;f++){var d=i[f];if("kern"==d.tag)for(var u=0;u<d.tab.length;u++)if(!h[d.tab[u]]){h[d.tab[u]]=!0;for(var l=s[d.tab[u]],v=0;v<l.tabs.length;v++)if(null!=l.tabs[v]){var c,p=l.tabs[v];if(!p.coverage||-1!=(c=e._lctf.coverageIndex(p.coverage,t)))if(1==l.ltype);else if(2==l.ltype){var U;if(1==p.fmt){var g=p.pairsets[c];for(f=0;f<g.length;f++)g[f].gid2==a&&(U=g[f]);}else if(2==p.fmt){var S=e.U._getGlyphClass(t,p.classDef1),m=e.U._getGlyphClass(a,p.classDef2);U=p.matrix[S][m];}U&&U.val1&&U.val1[2]&&(n+=U.val1[2]),U&&U.val2&&U.val2[0]&&(n+=U.val2[0]);}}}}if(r.kern){var b=r.kern.glyph1.indexOf(t);if(-1!=b){var y=r.kern.rval[b].glyph2.indexOf(a);-1!=y&&(n+=r.kern.rval[b].vals[y]);}}return n},e.U._applySubs=function(r,t,a,n){for(var o=r.length-t-1,s=0;s<a.tabs.length;s++)if(null!=a.tabs[s]){var i,h=a.tabs[s];if(!h.coverage||-1!=(i=e._lctf.coverageIndex(h.coverage,r[t])))if(1==a.ltype)r[t],1==h.fmt?r[t]=r[t]+h.delta:r[t]=h.newg[i];else if(4==a.ltype)for(var f=h.vals[i],d=0;d<f.length;d++){var u=f[d],l=u.chain.length;if(!(l>o)){for(var v=!0,c=0,p=0;p<l;p++){for(;-1==r[t+c+(1+p)];)c++;u.chain[p]!=r[t+c+(1+p)]&&(v=!1);}if(v){r[t]=u.nglyph;for(p=0;p<l+c;p++)r[t+p+1]=-1;break}}}else if(5==a.ltype&&2==h.fmt)for(var U=e._lctf.getInterval(h.cDef,r[t]),g=h.cDef[U+2],S=h.scset[g],m=0;m<S.length;m++){var b=S[m],y=b.input;if(!(y.length>o)){for(v=!0,p=0;p<y.length;p++){var F=e._lctf.getInterval(h.cDef,r[t+1+p]);if(-1==U&&h.cDef[F+2]!=y[p]){v=!1;break}}if(v){var _=b.substLookupRecords;for(d=0;d<_.length;d+=2)_[d],_[d+1];}}}else if(6==a.ltype&&3==h.fmt){if(!e.U._glsCovered(r,h.backCvg,t-h.backCvg.length))continue;if(!e.U._glsCovered(r,h.inptCvg,t))continue;if(!e.U._glsCovered(r,h.ahedCvg,t+h.inptCvg.length))continue;var C=h.lookupRec;for(m=0;m<C.length;m+=2){U=C[m];var x=n[C[m+1]];e.U._applySubs(r,t+U,x,n);}}}},e.U._glsCovered=function(r,t,a){for(var n=0;n<t.length;n++){if(-1==e._lctf.coverageIndex(t[n],r[a+n]))return !1}return !0},e.U.glyphsToPath=function(r,t,a){for(var n={cmds:[],crds:[]},o=0,s=0;s<t.length;s++){var i=t[s];if(-1!=i){for(var h=s<t.length-1&&-1!=t[s+1]?t[s+1]:0,f=e.U.glyphToPath(r,i),d=0;d<f.crds.length;d+=2)n.crds.push(f.crds[d]+o),n.crds.push(f.crds[d+1]);a&&n.cmds.push(a);for(d=0;d<f.cmds.length;d++)n.cmds.push(f.cmds[d]);a&&n.cmds.push("X"),o+=r.hmtx.aWidth[i],s<t.length-1&&(o+=e.U.getPairAdjustment(r,i,h));}}return n},e.U.P={},e.U.P.moveTo=function(r,e,t){r.cmds.push("M"),r.crds.push(e,t);},e.U.P.lineTo=function(r,e,t){r.cmds.push("L"),r.crds.push(e,t);},e.U.P.curveTo=function(r,e,t,a,n,o,s){r.cmds.push("C"),r.crds.push(e,t,a,n,o,s);},e.U.P.qcurveTo=function(r,e,t,a,n){r.cmds.push("Q"),r.crds.push(e,t,a,n);},e.U.P.closePath=function(r){r.cmds.push("Z");},e.U._drawCFF=function(r,t,a,n,o){for(var s=t.stack,i=t.nStems,h=t.haveWidth,f=t.width,d=t.open,u=0,l=t.x,v=t.y,c=0,p=0,U=0,g=0,S=0,m=0,b=0,y=0,F=0,_=0,C={val:0,size:0};u<r.length;){e.CFF.getCharString(r,u,C);var x=C.val;if(u+=C.size,"o1"==x||"o18"==x)s.length%2!=0&&!h&&(f=s.shift()+n.nominalWidthX),i+=s.length>>1,s.length=0,h=!0;else if("o3"==x||"o23"==x){s.length%2!=0&&!h&&(f=s.shift()+n.nominalWidthX),i+=s.length>>1,s.length=0,h=!0;}else if("o4"==x)s.length>1&&!h&&(f=s.shift()+n.nominalWidthX,h=!0),d&&e.U.P.closePath(o),v+=s.pop(),e.U.P.moveTo(o,l,v),d=!0;else if("o5"==x)for(;s.length>0;)l+=s.shift(),v+=s.shift(),e.U.P.lineTo(o,l,v);else if("o6"==x||"o7"==x)for(var P=s.length,I="o6"==x,w=0;w<P;w++){var O=s.shift();I?l+=O:v+=O,I=!I,e.U.P.lineTo(o,l,v);}else if("o8"==x||"o24"==x){P=s.length;for(var T=0;T+6<=P;)c=l+s.shift(),p=v+s.shift(),U=c+s.shift(),g=p+s.shift(),l=U+s.shift(),v=g+s.shift(),e.U.P.curveTo(o,c,p,U,g,l,v),T+=6;"o24"==x&&(l+=s.shift(),v+=s.shift(),e.U.P.lineTo(o,l,v));}else {if("o11"==x)break;if("o1234"==x||"o1235"==x||"o1236"==x||"o1237"==x)"o1234"==x&&(p=v,U=(c=l+s.shift())+s.shift(),_=g=p+s.shift(),m=g,y=v,l=(b=(S=(F=U+s.shift())+s.shift())+s.shift())+s.shift(),e.U.P.curveTo(o,c,p,U,g,F,_),e.U.P.curveTo(o,S,m,b,y,l,v)),"o1235"==x&&(c=l+s.shift(),p=v+s.shift(),U=c+s.shift(),g=p+s.shift(),F=U+s.shift(),_=g+s.shift(),S=F+s.shift(),m=_+s.shift(),b=S+s.shift(),y=m+s.shift(),l=b+s.shift(),v=y+s.shift(),s.shift(),e.U.P.curveTo(o,c,p,U,g,F,_),e.U.P.curveTo(o,S,m,b,y,l,v)),"o1236"==x&&(c=l+s.shift(),p=v+s.shift(),U=c+s.shift(),_=g=p+s.shift(),m=g,b=(S=(F=U+s.shift())+s.shift())+s.shift(),y=m+s.shift(),l=b+s.shift(),e.U.P.curveTo(o,c,p,U,g,F,_),e.U.P.curveTo(o,S,m,b,y,l,v)),"o1237"==x&&(c=l+s.shift(),p=v+s.shift(),U=c+s.shift(),g=p+s.shift(),F=U+s.shift(),_=g+s.shift(),S=F+s.shift(),m=_+s.shift(),b=S+s.shift(),y=m+s.shift(),Math.abs(b-l)>Math.abs(y-v)?l=b+s.shift():v=y+s.shift(),e.U.P.curveTo(o,c,p,U,g,F,_),e.U.P.curveTo(o,S,m,b,y,l,v));else if("o14"==x){if(s.length>0&&!h&&(f=s.shift()+a.nominalWidthX,h=!0),4==s.length){var k=s.shift(),G=s.shift(),D=s.shift(),B=s.shift(),A=e.CFF.glyphBySE(a,D),R=e.CFF.glyphBySE(a,B);e.U._drawCFF(a.CharStrings[A],t,a,n,o),t.x=k,t.y=G,e.U._drawCFF(a.CharStrings[R],t,a,n,o);}d&&(e.U.P.closePath(o),d=!1);}else if("o19"==x||"o20"==x){s.length%2!=0&&!h&&(f=s.shift()+n.nominalWidthX),i+=s.length>>1,s.length=0,h=!0,u+=i+7>>3;}else if("o21"==x)s.length>2&&!h&&(f=s.shift()+n.nominalWidthX,h=!0),v+=s.pop(),l+=s.pop(),d&&e.U.P.closePath(o),e.U.P.moveTo(o,l,v),d=!0;else if("o22"==x)s.length>1&&!h&&(f=s.shift()+n.nominalWidthX,h=!0),l+=s.pop(),d&&e.U.P.closePath(o),e.U.P.moveTo(o,l,v),d=!0;else if("o25"==x){for(;s.length>6;)l+=s.shift(),v+=s.shift(),e.U.P.lineTo(o,l,v);c=l+s.shift(),p=v+s.shift(),U=c+s.shift(),g=p+s.shift(),l=U+s.shift(),v=g+s.shift(),e.U.P.curveTo(o,c,p,U,g,l,v);}else if("o26"==x)for(s.length%2&&(l+=s.shift());s.length>0;)c=l,p=v+s.shift(),l=U=c+s.shift(),v=(g=p+s.shift())+s.shift(),e.U.P.curveTo(o,c,p,U,g,l,v);else if("o27"==x)for(s.length%2&&(v+=s.shift());s.length>0;)p=v,U=(c=l+s.shift())+s.shift(),g=p+s.shift(),l=U+s.shift(),v=g,e.U.P.curveTo(o,c,p,U,g,l,v);else if("o10"==x||"o29"==x){var L="o10"==x?n:a;if(0==s.length)console.debug("error: empty stack");else {var W=s.pop(),M=L.Subrs[W+L.Bias];t.x=l,t.y=v,t.nStems=i,t.haveWidth=h,t.width=f,t.open=d,e.U._drawCFF(M,t,a,n,o),l=t.x,v=t.y,i=t.nStems,h=t.haveWidth,f=t.width,d=t.open;}}else if("o30"==x||"o31"==x){var N=s.length,V=(T=0,"o31"==x);for(T+=N-(P=-3&N);T<P;)V?(p=v,U=(c=l+s.shift())+s.shift(),v=(g=p+s.shift())+s.shift(),P-T==5?(l=U+s.shift(),T++):l=U,V=!1):(c=l,p=v+s.shift(),U=c+s.shift(),g=p+s.shift(),l=U+s.shift(),P-T==5?(v=g+s.shift(),T++):v=g,V=!0),e.U.P.curveTo(o,c,p,U,g,l,v),T+=4;}else {if("o"==(x+"").charAt(0))throw console.debug("Unknown operation: "+x,r),x;s.push(x);}}}t.x=l,t.y=v,t.nStems=i,t.haveWidth=h,t.width=f,t.open=d;};var t=e,a={Typr:t};return r.Typr=t,r.default=a,Object.defineProperty(r,"__esModule",{value:!0}),r}({}).Typr}

  /*!
  Custom bundle of woff2otf (https://github.com/arty-name/woff2otf) with fflate
  (https://github.com/101arrowz/fflate) for use in Troika text rendering. 
  Original licenses apply: 
  - fflate: https://github.com/101arrowz/fflate/blob/master/LICENSE (MIT)
  - woff2otf.js: https://github.com/arty-name/woff2otf/blob/master/woff2otf.js (Apache2)
  */
  function woff2otfFactory(){return function(r){var e=Uint8Array,n=Uint16Array,t=Uint32Array,a=new e([0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0,0,0,0]),f=new e([0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13,0,0]),i=new e([16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15]),o=function(r,e){for(var a=new n(31),f=0;f<31;++f)a[f]=e+=1<<r[f-1];var i=new t(a[30]);for(f=1;f<30;++f)for(var o=a[f];o<a[f+1];++o)i[o]=o-a[f]<<5|f;return [a,i]},u=o(a,2),v=u[0],s=u[1];v[28]=258,s[258]=28;for(var l=o(f,0)[0],c=new n(32768),g=0;g<32768;++g){var h=(43690&g)>>>1|(21845&g)<<1;h=(61680&(h=(52428&h)>>>2|(13107&h)<<2))>>>4|(3855&h)<<4,c[g]=((65280&h)>>>8|(255&h)<<8)>>>1;}var w=function(r,e,t){for(var a=r.length,f=0,i=new n(e);f<a;++f)++i[r[f]-1];var o,u=new n(e);for(f=0;f<e;++f)u[f]=u[f-1]+i[f-1]<<1;if(t){o=new n(1<<e);var v=15-e;for(f=0;f<a;++f)if(r[f])for(var s=f<<4|r[f],l=e-r[f],g=u[r[f]-1]++<<l,h=g|(1<<l)-1;g<=h;++g)o[c[g]>>>v]=s;}else for(o=new n(a),f=0;f<a;++f)o[f]=c[u[r[f]-1]++]>>>15-r[f];return o},m=new e(288);for(g=0;g<144;++g)m[g]=8;for(g=144;g<256;++g)m[g]=9;for(g=256;g<280;++g)m[g]=7;for(g=280;g<288;++g)m[g]=8;var b=new e(32);for(g=0;g<32;++g)b[g]=5;var p=w(m,9,1),d=w(b,5,1),L=function(r){for(var e=r[0],n=1;n<r.length;++n)r[n]>e&&(e=r[n]);return e},y=function(r,e,n){var t=e/8>>0;return (r[t]|r[t+1]<<8)>>>(7&e)&n},U=function(r,e){var n=e/8>>0;return (r[n]|r[n+1]<<8|r[n+2]<<16)>>>(7&e)},O=function(r,o,u){var s=r.length,c=!o||u,g=!u||u.i;u||(u={}),o||(o=new e(3*s));var h,m=function(r){var n=o.length;if(r>n){var t=new e(Math.max(2*n,r));t.set(o),o=t;}},b=u.f||0,O=u.p||0,A=u.b||0,k=u.l,x=u.d,E=u.m,T=u.n,F=8*s;do{if(!k){u.f=b=y(r,O,1);var V=y(r,O+1,3);if(O+=3,!V){var M=r[(I=((h=O)/8>>0)+(7&h&&1)+4)-4]|r[I-3]<<8,C=I+M;if(C>s){if(g)throw "unexpected EOF";break}c&&m(A+M),o.set(r.subarray(I,C),A),u.b=A+=M,u.p=O=8*C;continue}if(1==V)k=p,x=d,E=9,T=5;else {if(2!=V)throw "invalid block type";var D=y(r,O,31)+257,S=y(r,O+10,15)+4,_=D+y(r,O+5,31)+1;O+=14;for(var j=new e(_),z=new e(19),q=0;q<S;++q)z[i[q]]=y(r,O+3*q,7);O+=3*S;var B=L(z),G=(1<<B)-1;if(!g&&O+_*(B+7)>F)break;var H=w(z,B,1);for(q=0;q<_;){var I,J=H[y(r,O,G)];if(O+=15&J,(I=J>>>4)<16)j[q++]=I;else {var K=0,N=0;for(16==I?(N=3+y(r,O,3),O+=2,K=j[q-1]):17==I?(N=3+y(r,O,7),O+=3):18==I&&(N=11+y(r,O,127),O+=7);N--;)j[q++]=K;}}var P=j.subarray(0,D),Q=j.subarray(D);E=L(P),T=L(Q),k=w(P,E,1),x=w(Q,T,1);}if(O>F)throw "unexpected EOF"}c&&m(A+131072);for(var R=(1<<E)-1,W=(1<<T)-1,X=E+T+18;g||O+X<F;){var Y=(K=k[U(r,O)&R])>>>4;if((O+=15&K)>F)throw "unexpected EOF";if(!K)throw "invalid length/literal";if(Y<256)o[A++]=Y;else {if(256==Y){k=null;break}var Z=Y-254;if(Y>264){var $=a[q=Y-257];Z=y(r,O,(1<<$)-1)+v[q],O+=$;}var rr=x[U(r,O)&W],er=rr>>>4;if(!rr)throw "invalid distance";O+=15&rr;Q=l[er];if(er>3){$=f[er];Q+=U(r,O)&(1<<$)-1,O+=$;}if(O>F)throw "unexpected EOF";c&&m(A+131072);for(var nr=A+Z;A<nr;A+=4)o[A]=o[A-Q],o[A+1]=o[A+1-Q],o[A+2]=o[A+2-Q],o[A+3]=o[A+3-Q];A=nr;}}u.l=k,u.p=O,u.b=A,k&&(b=1,u.m=E,u.d=x,u.n=T);}while(!b);return A==o.length?o:function(r,a,f){(null==a||a<0)&&(a=0),(null==f||f>r.length)&&(f=r.length);var i=new(r instanceof n?n:r instanceof t?t:e)(f-a);return i.set(r.subarray(a,f)),i}(o,0,A)};return r.convert_streams=function(r){var e=new DataView(r),n=0;function t(){var r=e.getUint16(n);return n+=2,r}function a(){var r=e.getUint32(n);return n+=4,r}function f(r){b.setUint16(p,r),p+=2;}function i(r){b.setUint32(p,r),p+=4;}for(var o={signature:a(),flavor:a(),length:a(),numTables:t(),reserved:t(),totalSfntSize:a(),majorVersion:t(),minorVersion:t(),metaOffset:a(),metaLength:a(),metaOrigLength:a(),privOffset:a(),privLength:a()},u=0;Math.pow(2,u)<=o.numTables;)u++;u--;for(var v=16*Math.pow(2,u),s=16*o.numTables-v,l=12,c=[],g=0;g<o.numTables;g++)c.push({tag:a(),offset:a(),compLength:a(),origLength:a(),origChecksum:a()}),l+=16;var h,w=new Uint8Array(12+16*c.length+c.reduce((function(r,e){return r+e.origLength+4}),0)),m=w.buffer,b=new DataView(m),p=0;return i(o.flavor),f(o.numTables),f(v),f(u),f(s),c.forEach((function(r){i(r.tag),i(r.origChecksum),i(l),i(r.origLength),r.outOffset=l,(l+=r.origLength)%4!=0&&(l+=4-l%4);})),c.forEach((function(e){var n,t=r.slice(e.offset,e.offset+e.compLength);if(e.compLength!=e.origLength){var a=new Uint8Array(e.origLength);n=new Uint8Array(t,2),O(n,a);}else a=new Uint8Array(t);w.set(a,e.outOffset);var f=0;(l=e.outOffset+e.origLength)%4!=0&&(f=4-l%4),w.set(new Uint8Array(f).buffer,e.outOffset+e.origLength),h=l+f;})),m.slice(0,h)},r}({}).convert_streams}

  /**
   * An adapter that allows Typr.js to be used as if it were (a subset of) the OpenType.js API.
   * Also adds support for WOFF files (not WOFF2).
   */

  function parserFactory(Typr, woff2otf) {
    const cmdArgLengths = {
      M: 2,
      L: 2,
      Q: 4,
      C: 6,
      Z: 0
    };

    // {joinType: "skip+step,..."}
    const joiningTypeRawData = {"C":"18g,ca,368,1kz","D":"17k,6,2,2+4,5+c,2+6,2+1,10+1,9+f,j+11,2+1,a,2,2+1,15+2,3,j+2,6+3,2+8,2,2,2+1,w+a,4+e,3+3,2,3+2,3+5,23+w,2f+4,3,2+9,2,b,2+3,3,1k+9,6+1,3+1,2+2,2+d,30g,p+y,1,1+1g,f+x,2,sd2+1d,jf3+4,f+3,2+4,2+2,b+3,42,2,4+2,2+1,2,3,t+1,9f+w,2,el+2,2+g,d+2,2l,2+1,5,3+1,2+1,2,3,6,16wm+1v","R":"17m+3,2,2,6+3,m,15+2,2+2,h+h,13,3+8,2,2,3+1,2,p+1,x,5+4,5,a,2,2,3,u,c+2,g+1,5,2+1,4+1,5j,6+1,2,b,2+2,f,2+1,1s+2,2,3+1,7,1ez0,2,2+1,4+4,b,4,3,b,42,2+2,4,3,2+1,2,o+3,ae,ep,x,2o+2,3+1,3,5+1,6","L":"x9u,jff,a,fd,jv","T":"4t,gj+33,7o+4,1+1,7c+18,2,2+1,2+1,2,21+a,2,1b+k,h,2u+6,3+5,3+1,2+3,y,2,v+q,2k+a,1n+8,a,p+3,2+8,2+2,2+4,18+2,3c+e,2+v,1k,2,5+7,5,4+6,b+1,u,1n,5+3,9,l+1,r,3+1,1m,5+1,5+1,3+2,4,v+1,4,c+1,1m,5+4,2+1,5,l+1,n+5,2,1n,3,2+3,9,8+1,c+1,v,1q,d,1f,4,1m+2,6+2,2+3,8+1,c+1,u,1n,3,7,6+1,l+1,t+1,1m+1,5+3,9,l+1,u,21,8+2,2,2j,3+6,d+7,2r,3+8,c+5,23+1,s,2,2,1k+d,2+4,2+1,6+a,2+z,a,2v+3,2+5,2+1,3+1,q+1,5+2,h+3,e,3+1,7,g,jk+2,qb+2,u+2,u+1,v+1,1t+1,2+6,9,3+a,a,1a+2,3c+1,z,3b+2,5+1,a,7+2,64+1,3,1n,2+6,2,2,3+7,7+9,3,1d+d,1,1+1,1s+3,1d,2+4,2,6,15+8,d+1,x+3,3+1,2+2,1l,2+1,4,2+2,1n+7,3+1,49+2,2+c,2+6,5,7,4+1,5j+1l,2+4,ek,3+1,r+4,1e+4,6+5,2p+c,1+3,1,1+2,1+b,2db+2,3y,2p+v,ff+3,30+1,n9x,1+2,2+9,x+1,29+1,7l,4,5,q+1,6,48+1,r+h,e,13+7,q+a,1b+2,1d,3+3,3+1,14,1w+5,3+1,3+1,d,9,1c,1g,2+2,3+1,6+1,2,17+1,9,6n,3,5,fn5,ki+f,h+f,5s,6y+2,ea,6b,46+4,1af+2,2+1,6+3,15+2,5,4m+1,fy+3,as+1,4a+a,4x,1j+e,1l+2,1e+3,3+1,1y+2,11+4,2+7,1r,d+1,1h+8,b+3,3,2o+2,3,2+1,7,4h,4+7,m+1,1m+1,4,12+6,4+4,5g+7,3+2,2,o,2d+5,2,5+1,2+1,6n+3,7+1,2+1,s+1,2e+7,3,2+1,2z,2,3+5,2,2u+2,3+3,2+4,78+8,2+1,75+1,2,5,41+3,3+1,5,x+9,15+5,3+3,9,a+5,3+2,1b+c,2+1,bb+6,2+5,2,2b+l,3+6,2+1,2+1,3f+5,4,2+1,2+6,2,21+1,4,2,9o+1,470+8,at4+4,1o+6,t5,1s+3,2a,f5l+1,2+3,43o+2,a+7,1+7,3+6,v+3,45+2,1j0+1i,5+1d,9,f,n+4,2+e,11t+6,2+g,3+6,2+1,2+4,7a+6,c6+3,15t+6,32+6,1,gzau,v+2n,3l+6n"};

    const JT_LEFT = 1, //indicates that a character joins with the subsequent character, but does not join with the preceding character.
      JT_RIGHT = 2, //indicates that a character joins with the preceding character, but does not join with the subsequent character.
      JT_DUAL = 4, //indicates that a character joins with the preceding character and joins with the subsequent character.
      JT_TRANSPARENT = 8, //indicates that the character does not join with adjacent characters and that the character must be skipped over when the shaping engine is evaluating the joining positions in a sequence of characters. When a JT_TRANSPARENT character is encountered in a sequence, the JOINING_TYPE of the preceding character passes through. Diacritical marks are frequently assigned this value.
      JT_JOIN_CAUSING = 16, //indicates that the character forces the use of joining forms with the preceding and subsequent characters. Kashidas and the Zero Width Joiner (U+200D) are both JOIN_CAUSING characters.
      JT_NON_JOINING = 32; //indicates that a character does not join with the preceding or with the subsequent character.,

    let joiningTypeMap;
    function getCharJoiningType(ch) {
      if (!joiningTypeMap) {
        const m = {
          R: JT_RIGHT,
          L: JT_LEFT,
          D: JT_DUAL,
          C: JT_JOIN_CAUSING,
          U: JT_NON_JOINING,
          T: JT_TRANSPARENT
        };
        joiningTypeMap = new Map();
        for (let type in joiningTypeRawData) {
          let lastCode = 0;
          joiningTypeRawData[type].split(',').forEach(range => {
            let [skip, step] = range.split('+');
            skip = parseInt(skip,36);
            step = step ? parseInt(step, 36) : 0;
            joiningTypeMap.set(lastCode += skip, m[type]);
            for (let i = step; i--;) {
              joiningTypeMap.set(++lastCode, m[type]);
            }
          });
        }
      }
      return joiningTypeMap.get(ch) || JT_NON_JOINING
    }

    const ISOL = 1, INIT = 2, FINA = 3, MEDI = 4;
    const formsToFeatures = [null, 'isol', 'init', 'fina', 'medi'];

    function detectJoiningForms(str) {
      // This implements the algorithm described here:
      // https://github.com/n8willis/opentype-shaping-documents/blob/master/opentype-shaping-arabic-general.md
      const joiningForms = new Uint8Array(str.length);
      let prevJoiningType = JT_NON_JOINING;
      let prevForm = ISOL;
      let prevIndex = -1;
      for (let i = 0; i < str.length; i++) {
        const code = str.codePointAt(i);
        let joiningType = getCharJoiningType(code) | 0;
        let form = ISOL;
        if (joiningType & JT_TRANSPARENT) {
          continue
        }
        if (prevJoiningType & (JT_LEFT | JT_DUAL | JT_JOIN_CAUSING)) {
          if (joiningType & (JT_RIGHT | JT_DUAL | JT_JOIN_CAUSING)) {
            form = FINA;
            // isol->init, fina->medi
            if (prevForm === ISOL || prevForm === FINA) {
              joiningForms[prevIndex]++;
            }
          }
          else if (joiningType & (JT_LEFT | JT_NON_JOINING)) {
            // medi->fina, init->isol
            if (prevForm === INIT || prevForm === MEDI) {
              joiningForms[prevIndex]--;
            }
          }
        }
        else if (prevJoiningType & (JT_RIGHT | JT_NON_JOINING)) {
          // medi->fina, init->isol
          if (prevForm === INIT || prevForm === MEDI) {
            joiningForms[prevIndex]--;
          }
        }
        prevForm = joiningForms[i] = form;
        prevJoiningType = joiningType;
        prevIndex = i;
        if (code > 0xffff) i++;
      }
      // console.log(str.split('').map(ch => ch.codePointAt(0).toString(16)))
      // console.log(str.split('').map(ch => getCharJoiningType(ch.codePointAt(0))))
      // console.log(Array.from(joiningForms).map(f => formsToFeatures[f] || 'none'))
      return joiningForms
    }

    function stringToGlyphs (font, str) {
      const glyphIds = [];
      for (let i = 0; i < str.length; i++) {
        const cc = str.codePointAt(i);
        if (cc > 0xffff) i++;
        glyphIds.push(Typr.U.codeToGlyph(font, cc));
      }

      const gsub = font['GSUB'];
      if (gsub) {
        const {lookupList, featureList} = gsub;
        let joiningForms;
        const supportedFeatures = /^(rlig|liga|mset|isol|init|fina|medi|half|pres|blws)$/;
        const usedLookups = [];
        featureList.forEach(feature => {
          if (supportedFeatures.test(feature.tag)) {
            for (let ti = 0; ti < feature.tab.length; ti++) {
              if (usedLookups[feature.tab[ti]]) continue
              usedLookups[feature.tab[ti]] = true;
              const tab = lookupList[feature.tab[ti]];
              const isJoiningFeature = /^(isol|init|fina|medi)$/.test(feature.tag);
              if (isJoiningFeature && !joiningForms) { //lazy
                joiningForms = detectJoiningForms(str);
              }
              for (let ci = 0; ci < glyphIds.length; ci++) {
                if (!joiningForms || !isJoiningFeature || formsToFeatures[joiningForms[ci]] === feature.tag) {
                  Typr.U._applySubs(glyphIds, ci, tab, lookupList);
                }
              }
            }
          }
        });
      }

      return glyphIds
    }


    function wrapFontObj(typrFont) {
      const glyphMap = Object.create(null);

      const fontObj = {
        unitsPerEm: typrFont.head.unitsPerEm,
        ascender: typrFont.hhea.ascender,
        descender: typrFont.hhea.descender,
        forEachGlyph(text, fontSize, letterSpacing, callback) {
          let glyphX = 0;
          const fontScale = 1 / fontObj.unitsPerEm * fontSize;

          const glyphIndices = stringToGlyphs(typrFont, text);
          let charIndex = 0;
          let prevGlyphIndex = -1;
          glyphIndices.forEach((glyphIndex, i) => {
            // Typr returns a glyph index per string codepoint, with -1s in place of those that
            // were omitted due to ligature substitution. So we can track original index in the
            // string via simple increment, and skip everything else when seeing a -1.
            if (glyphIndex !== -1) {
              let glyphObj = glyphMap[glyphIndex];
              if (!glyphObj) {
                const {cmds, crds} = Typr.U.glyphToPath(typrFont, glyphIndex);

                // Find extents - Glyf gives this in metadata but not CFF, and Typr doesn't
                // normalize the two, so it's simplest just to iterate ourselves.
                let xMin, yMin, xMax, yMax;
                if (crds.length) {
                  xMin = yMin = Infinity;
                  xMax = yMax = -Infinity;
                  for (let i = 0, len = crds.length; i < len; i += 2) {
                    let x = crds[i];
                    let y = crds[i + 1];
                    if (x < xMin) xMin = x;
                    if (y < yMin) yMin = y;
                    if (x > xMax) xMax = x;
                    if (y > yMax) yMax = y;
                  }
                } else {
                  xMin = xMax = yMin = yMax = 0;
                }

                glyphObj = glyphMap[glyphIndex] = {
                  index: glyphIndex,
                  advanceWidth: typrFont.hmtx.aWidth[glyphIndex],
                  xMin,
                  yMin,
                  xMax,
                  yMax,
                  pathCommandCount: cmds.length,
                  forEachPathCommand(callback) {
                    let argsIndex = 0;
                    const argsArray = [];
                    for (let i = 0, len = cmds.length; i < len; i++) {
                      const numArgs = cmdArgLengths[cmds[i]];
                      argsArray.length = 1 + numArgs;
                      argsArray[0] = cmds[i];
                      for (let j = 1; j <= numArgs; j++) {
                        argsArray[j] = crds[argsIndex++];
                      }
                      callback.apply(null, argsArray);
                    }
                  }
                };
              }

              // Kerning
              if (prevGlyphIndex !== -1) {
                glyphX += Typr.U.getPairAdjustment(typrFont, prevGlyphIndex, glyphIndex) * fontScale;
              }

              callback.call(null, glyphObj, glyphX, charIndex);

              if (glyphObj.advanceWidth) {
                glyphX += glyphObj.advanceWidth * fontScale;
              }
              if (letterSpacing) {
                glyphX += letterSpacing * fontSize;
              }

              prevGlyphIndex = glyphIndex;
            }
            charIndex += (text.codePointAt(charIndex) > 0xffff ? 2 : 1);
          });
          return glyphX
        }
      };

      return fontObj
    }

    return function parse(buffer) {
      // Look to see if we have a WOFF file and convert it if so:
      const peek = new Uint8Array(buffer, 0, 4);
      const tag = Typr._bin.readASCII(peek, 0, 4);
      if (tag === 'wOFF') {
        buffer = woff2otf(buffer);
      } else if (tag === 'wOF2') {
        throw new Error('woff2 fonts not supported')
      }
      return wrapFontObj(Typr.parse(buffer)[0])
    }
  }


  const workerModule = /*#__PURE__*/defineWorkerModule({
    name: 'Typr Font Parser',
    dependencies: [typrFactory, woff2otfFactory, parserFactory],
    init(typrFactory, woff2otfFactory, parserFactory) {
      const Typr = typrFactory();
      const woff2otf = woff2otfFactory();
      return parserFactory(Typr, woff2otf)
    }
  });

  // import fontParser from './worker/FontParser_OpenType.js'


  const CONFIG = {
    defaultFontURL: 'https://fonts.gstatic.com/s/roboto/v18/KFOmCnqEu92Fr1Mu4mxM.woff', //Roboto Regular
    sdfGlyphSize: 64,
    sdfMargin: 1 / 16,
    sdfExponent: 9,
    textureWidth: 2048
  };
  const tempColor = /*#__PURE__*/new THREE.Color();

  /**
   * Repository for all font SDF atlas textures
   *
   *   {
   *     [font]: {
   *       sdfTexture: DataTexture
   *     }
   *   }
   */
  const atlases = Object.create(null);

  /**
   * @typedef {object} TroikaTextRenderInfo - Format of the result from `getTextRenderInfo`.
   * @property {object} parameters - The normalized input arguments to the render call.
   * @property {DataTexture} sdfTexture - The SDF atlas texture.
   * @property {number} sdfGlyphSize - The size of each glyph's SDF; see `configureTextBuilder`.
   * @property {number} sdfExponent - The exponent used in encoding the SDF's values; see `configureTextBuilder`.
   * @property {Float32Array} glyphBounds - List of [minX, minY, maxX, maxY] quad bounds for each glyph.
   * @property {Float32Array} glyphAtlasIndices - List holding each glyph's index in the SDF atlas.
   * @property {Uint8Array} [glyphColors] - List holding each glyph's [r, g, b] color, if `colorRanges` was supplied.
   * @property {Float32Array} [caretPositions] - A list of caret positions for all glyphs; this is
   *           the bottom [x,y] of the cursor position before each char, plus one after the last char.
   * @property {number} [caretHeight] - An appropriate height for all selection carets.
   * @property {number} ascender - The font's ascender metric.
   * @property {number} descender - The font's descender metric.
   * @property {number} lineHeight - The final computed lineHeight measurement.
   * @property {number} topBaseline - The y position of the top line's baseline.
   * @property {Array<number>} blockBounds - The total [minX, minY, maxX, maxY] rect of the whole text block;
   *           this can include extra vertical space beyond the visible glyphs due to lineHeight, and is
   *           equivalent to the dimensions of a block-level text element in CSS.
   * @property {Array<number>} visibleBounds - The total [minX, minY, maxX, maxY] rect of the whole text block;
   *           unlike `blockBounds` this is tightly wrapped to the visible glyph paths.
   * @property {Array<number>} totalBounds - DEPRECATED; use blockBounds instead.
   * @property {Array<number>} totalBlockSize - DEPRECATED; use blockBounds instead
   * @property {Array<object>} chunkedBounds - List of bounding rects for each consecutive set of N glyphs,
   *           in the format `{start:N, end:N, rect:[minX, minY, maxX, maxY]}`.
   * @property {object} timings - Timing info for various parts of the rendering logic including SDF
   *           generation, layout, etc.
   * @frozen
   */

  /**
   * @callback getTextRenderInfo~callback
   * @param {TroikaTextRenderInfo} textRenderInfo
   */

  /**
   * Main entry point for requesting the data needed to render a text string with given font parameters.
   * This is an asynchronous call, performing most of the logic in a web worker thread.
   * @param {object} args
   * @param {getTextRenderInfo~callback} callback
   */
  function getTextRenderInfo(args, callback) {
    args = assign({}, args);

    // Apply default font here to avoid a 'null' atlas, and convert relative
    // URLs to absolute so they can be resolved in the worker
    args.font = toAbsoluteURL(args.font || CONFIG.defaultFontURL);

    // Normalize text to a string
    args.text = '' + args.text;

    args.sdfGlyphSize = args.sdfGlyphSize || CONFIG.sdfGlyphSize;

    // Normalize colors
    if (args.colorRanges != null) {
      let colors = {};
      for (let key in args.colorRanges) {
        if (args.colorRanges.hasOwnProperty(key)) {
          let val = args.colorRanges[key];
          if (typeof val !== 'number') {
            val = tempColor.set(val).getHex();
          }
          colors[key] = val;
        }
      }
      args.colorRanges = colors;
    }

    Object.freeze(args);

    // Init the atlas for this font if needed
    const {textureWidth, sdfExponent} = CONFIG;
    const {sdfGlyphSize} = args;
    let atlasKey = `${args.font}@${sdfGlyphSize}`;
    let atlas = atlases[atlasKey];
    if (!atlas) {
      atlas = atlases[atlasKey] = {
        sdfTexture: new THREE.DataTexture(
          new Uint8Array(sdfGlyphSize * textureWidth * 4),
          textureWidth,
          sdfGlyphSize,
          THREE.RGBAFormat,
          undefined,
          undefined,
          undefined,
          undefined,
          THREE.LinearFilter,
          THREE.LinearFilter
        )
      };
      atlas.sdfTexture.font = args.font;
    }

    // Issue request to the FontProcessor in the worker
    processInWorker(args).then(result => {
      // If the response has newGlyphs, copy them into the atlas texture at the specified indices
      if (result.newGlyphSDFs) {
        result.newGlyphSDFs.forEach(({textureData, atlasIndex}) => {
          const texImg = atlas.sdfTexture.image;

          // Grow the texture by power of 2 if needed
          while (texImg.data.length < (atlasIndex + 1) * sdfGlyphSize * sdfGlyphSize) {
            const biggerArray = new Uint8Array(texImg.data.length * 2);
            biggerArray.set(texImg.data);
            texImg.data = biggerArray;
            texImg.height *= 2;
          }

          // Insert the new glyph's data into the full texture image at the correct offsets
          // Glyphs are packed sequentially into the R,G,B,A channels of a square, advancing
          // to the next square every 4 glyphs.
          const squareIndex = Math.floor(atlasIndex / 4);
          const cols = texImg.width / sdfGlyphSize;
          const baseStartIndex = Math.floor(squareIndex / cols) * texImg.width * sdfGlyphSize * 4 //full rows
            + (squareIndex % cols) * sdfGlyphSize * 4 //partial row
            + (atlasIndex % 4); //color channel
          for (let y = 0; y < sdfGlyphSize; y++) {
            const srcStartIndex = y * sdfGlyphSize;
            const rowStartIndex = baseStartIndex + (y * texImg.width * 4);
            for (let x = 0; x < sdfGlyphSize; x++) {
              texImg.data[rowStartIndex + x * 4] = textureData[srcStartIndex + x];
            }
          }
        });
        atlas.sdfTexture.needsUpdate = true;
      }

      // Invoke callback with the text layout arrays and updated texture
      callback(Object.freeze({
        parameters: args,
        sdfTexture: atlas.sdfTexture,
        sdfGlyphSize,
        sdfExponent,
        glyphBounds: result.glyphBounds,
        glyphAtlasIndices: result.glyphAtlasIndices,
        glyphColors: result.glyphColors,
        caretPositions: result.caretPositions,
        caretHeight: result.caretHeight,
        chunkedBounds: result.chunkedBounds,
        ascender: result.ascender,
        descender: result.descender,
        lineHeight: result.lineHeight,
        topBaseline: result.topBaseline,
        blockBounds: result.blockBounds,
        visibleBounds: result.visibleBounds,
        timings: result.timings,
        get totalBounds() {
          console.log('totalBounds deprecated, use blockBounds instead');
          return result.blockBounds
        },
        get totalBlockSize() {
          console.log('totalBlockSize deprecated, use blockBounds instead');
          const [x0, y0, x1, y1] = result.blockBounds;
          return [x1 - x0, y1 - y0]
        }
      }));
    });
  }


  // Local assign impl so we don't have to import troika-core
  function assign(toObj, fromObj) {
    for (let key in fromObj) {
      if (fromObj.hasOwnProperty(key)) {
        toObj[key] = fromObj[key];
      }
    }
    return toObj
  }

  // Utility for making URLs absolute
  let linkEl;
  function toAbsoluteURL(path) {
    if (!linkEl) {
      linkEl = typeof document === 'undefined' ? {} : document.createElement('a');
    }
    linkEl.href = path;
    return linkEl.href
  }


  const fontProcessorWorkerModule = /*#__PURE__*/defineWorkerModule({
    name: 'FontProcessor',
    dependencies: [
      CONFIG,
      workerModule,
      createGlyphSegmentsIndex,
      createSDFGenerator,
      createFontProcessor,
      bidiFactory
    ],
    init(config, fontParser, createGlyphSegmentsIndex, createSDFGenerator, createFontProcessor, bidiFactory) {
      const {sdfExponent, sdfMargin, defaultFontURL} = config;
      const sdfGenerator = createSDFGenerator(createGlyphSegmentsIndex, { sdfExponent, sdfMargin });
      return createFontProcessor(fontParser, sdfGenerator, bidiFactory(), { defaultFontURL })
    }
  });

  const processInWorker = /*#__PURE__*/defineWorkerModule({
    name: 'TextBuilder',
    dependencies: [fontProcessorWorkerModule, ThenableWorkerModule],
    init(fontProcessor, Thenable) {
      return function(args) {
        const thenable = new Thenable();
        fontProcessor.process(args, thenable.resolve);
        return thenable
      }
    },
    getTransferables(result) {
      // Mark array buffers as transferable to avoid cloning during postMessage
      const transferables = [
        result.glyphBounds.buffer,
        result.glyphAtlasIndices.buffer
      ];
      if (result.caretPositions) {
        transferables.push(result.caretPositions.buffer);
      }
      if (result.newGlyphSDFs) {
        result.newGlyphSDFs.forEach(d => {
          transferables.push(d.textureData.buffer);
        });
      }
      return transferables
    }
  });

  const GlyphsGeometry = /*#__PURE__*/(() => {

    const templateGeometries = {};
    function getTemplateGeometry(detail) {
      let geom = templateGeometries[detail];
      if (!geom) {
        geom = templateGeometries[detail] = new THREE.PlaneBufferGeometry(1, 1, detail, detail).translate(0.5, 0.5, 0);
      }
      return geom
    }
    new THREE.Vector3();

    const glyphBoundsAttrName = 'aTroikaGlyphBounds';
    const glyphIndexAttrName = 'aTroikaGlyphIndex';
    const glyphColorAttrName = 'aTroikaGlyphColor';

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
    class GlyphsGeometry extends THREE.InstancedBufferGeometry {
      constructor() {
        super();

        this.detail = 1;
        this.curveRadius = 0;

        // Define groups for rendering text outline as a separate pass; these will only
        // be used when the `material` getter returns an array, i.e. outlineWidth > 0.
        this.groups = [
          {start: 0, count: Infinity, materialIndex: 0},
          {start: 0, count: Infinity, materialIndex: 1}
        ];

        // Preallocate empty bounding objects
        this.boundingSphere = new THREE.Sphere();
        this.boundingBox = new THREE.Box3();
      }

      computeBoundingSphere () {
        // No-op; we'll sync the boundingSphere proactively when needed.
      }

      computeBoundingBox() {
        // No-op; we'll sync the boundingBox proactively when needed.
      }

      set detail(detail) {
        if (detail !== this._detail) {
          this._detail = detail;
          if (typeof detail !== 'number' || detail < 1) {
            detail = 1;
          }
          let tpl = getTemplateGeometry(detail)
          ;['position', 'normal', 'uv'].forEach(attr => {
            this.attributes[attr] = tpl.attributes[attr].clone();
          });
          this.setIndex(tpl.getIndex().clone());
        }
      }
      get detail() {
        return this._detail
      }

      set curveRadius(r) {
        if (r !== this._curveRadius) {
          this._curveRadius = r;
          this._updateBounds();
        }
      }
      get curveRadius() {
        return this._curveRadius
      }

      /**
       * Update the geometry for a new set of glyphs.
       * @param {Float32Array} glyphBounds - An array holding the planar bounds for all glyphs
       *        to be rendered, 4 entries for each glyph: x1,x2,y1,y1
       * @param {Float32Array} glyphAtlasIndices - An array holding the index of each glyph within
       *        the SDF atlas texture.
       * @param {Array} blockBounds - An array holding the [minX, minY, maxX, maxY] across all glyphs
       * @param {Array} [chunkedBounds] - An array of objects describing bounds for each chunk of N
       *        consecutive glyphs: `{start:N, end:N, rect:[minX, minY, maxX, maxY]}`. This can be
       *        used with `applyClipRect` to choose an optimized `instanceCount`.
       * @param {Uint8Array} [glyphColors] - An array holding r,g,b values for each glyph.
       */
      updateGlyphs(glyphBounds, glyphAtlasIndices, blockBounds, chunkedBounds, glyphColors) {
        // Update the instance attributes
        updateBufferAttr(this, glyphBoundsAttrName, glyphBounds, 4);
        updateBufferAttr(this, glyphIndexAttrName, glyphAtlasIndices, 1);
        updateBufferAttr(this, glyphColorAttrName, glyphColors, 3);
        this._blockBounds = blockBounds;
        this._chunkedBounds = chunkedBounds;
        setInstanceCount(this, glyphAtlasIndices.length);
        this._updateBounds();
      }

      _updateBounds() {
        const bounds = this._blockBounds;
        if (bounds) {
          const { curveRadius, boundingBox: bbox } = this;
          if (curveRadius) {
            const { PI, floor, min, max, sin, cos } = Math;
            const halfPi = PI / 2;
            const twoPi = PI * 2;
            const absR = Math.abs(curveRadius);
            const leftAngle = bounds[0] / absR;
            const rightAngle = bounds[2] / absR;
            const minX = floor((leftAngle + halfPi) / twoPi) !== floor((rightAngle + halfPi) / twoPi)
              ? -absR : min(sin(leftAngle) * absR, sin(rightAngle) * absR);
            const maxX = floor((leftAngle - halfPi) / twoPi) !== floor((rightAngle - halfPi) / twoPi)
              ? absR : max(sin(leftAngle) * absR, sin(rightAngle) * absR);
            const maxZ = floor((leftAngle + PI) / twoPi) !== floor((rightAngle + PI) / twoPi)
              ? absR * 2 : max(absR - cos(leftAngle) * absR, absR - cos(rightAngle) * absR);
            bbox.min.set(minX, bounds[1], curveRadius < 0 ? -maxZ : 0);
            bbox.max.set(maxX, bounds[3], curveRadius < 0 ? 0 : maxZ);
          } else {
            bbox.min.set(bounds[0], bounds[1], 0);
            bbox.max.set(bounds[2], bounds[3], 0);
          }
          bbox.getBoundingSphere(this.boundingSphere);
        }
      }

      /**
       * Given a clipping rect, and the chunkedBounds from the last updateGlyphs call, choose the lowest
       * `instanceCount` that will show all glyphs within the clipped view. This is an optimization
       * for long blocks of text that are clipped, to skip vertex shader evaluation for glyphs that would
       * be clipped anyway.
       *
       * Note that since `drawElementsInstanced[ANGLE]` only accepts an instance count and not a starting
       * offset, this optimization becomes less effective as the clipRect moves closer to the end of the
       * text block. We could fix that by switching from instancing to a full geometry with a drawRange,
       * but at the expense of much larger attribute buffers (see classdoc above.)
       *
       * @param {Vector4} clipRect
       */
      applyClipRect(clipRect) {
        let count = this.getAttribute(glyphIndexAttrName).count;
        let chunks = this._chunkedBounds;
        if (chunks) {
          for (let i = chunks.length; i--;) {
            count = chunks[i].end;
            let rect = chunks[i].rect;
            // note: both rects are l-b-r-t
            if (rect[1] < clipRect.w && rect[3] > clipRect.y && rect[0] < clipRect.z && rect[2] > clipRect.x) {
              break
            }
          }
        }
        setInstanceCount(this, count);
      }
    }

    // Compat for pre r109:
    if (!GlyphsGeometry.prototype.setAttribute) {
      GlyphsGeometry.prototype.setAttribute = function(name, attribute) {
        this.attributes[ name ] = attribute;
        return this
      };
    }


    function updateBufferAttr(geom, attrName, newArray, itemSize) {
      const attr = geom.getAttribute(attrName);
      if (newArray) {
        // If length isn't changing, just update the attribute's array data
        if (attr && attr.array.length === newArray.length) {
          attr.array.set(newArray);
          attr.needsUpdate = true;
        } else {
          geom.setAttribute(attrName, new THREE.InstancedBufferAttribute(newArray, itemSize));
          // If the new attribute has a different size, we also have to (as of r117) manually clear the
          // internal cached max instance count. See https://github.com/mrdoob/three.js/issues/19706
          // It's unclear if this is a threejs bug or a truly unsupported scenario; discussion in
          // that ticket is ambiguous as to whether replacing a BufferAttribute with one of a
          // different size is supported, but https://github.com/mrdoob/three.js/pull/17418 strongly
          // implies it should be supported. It's possible we need to
          delete geom._maxInstanceCount; //for r117+, could be fragile
          geom.dispose(); //for r118+, more robust feeling, but more heavy-handed than I'd like
        }
      } else if (attr) {
        geom.deleteAttribute(attrName);
      }
    }

    // Handle maxInstancedCount -> instanceCount rename that happened in three r117
    function setInstanceCount(geom, count) {
      geom[geom.hasOwnProperty('instanceCount') ? 'instanceCount' : 'maxInstancedCount'] = count;
    }

    return GlyphsGeometry
  })();

  // language=GLSL
  const VERTEX_DEFS = `
uniform vec2 uTroikaSDFTextureSize;
uniform float uTroikaSDFGlyphSize;
uniform vec4 uTroikaTotalBounds;
uniform vec4 uTroikaClipRect;
uniform mat3 uTroikaOrient;
uniform bool uTroikaUseGlyphColors;
uniform float uTroikaDistanceOffset;
uniform float uTroikaBlurRadius;
uniform vec2 uTroikaPositionOffset;
uniform float uTroikaCurveRadius;
attribute vec4 aTroikaGlyphBounds;
attribute float aTroikaGlyphIndex;
attribute vec3 aTroikaGlyphColor;
varying vec2 vTroikaGlyphUV;
varying vec4 vTroikaTextureUVBounds;
varying float vTroikaTextureChannel;
varying vec3 vTroikaGlyphColor;
varying vec2 vTroikaGlyphDimensions;
`;

  // language=GLSL prefix="void main() {" suffix="}"
  const VERTEX_TRANSFORM = `
vec4 bounds = aTroikaGlyphBounds;
bounds.xz += uTroikaPositionOffset.x;
bounds.yw -= uTroikaPositionOffset.y;

vec4 outlineBounds = vec4(
  bounds.xy - uTroikaDistanceOffset - uTroikaBlurRadius,
  bounds.zw + uTroikaDistanceOffset + uTroikaBlurRadius
);
vec4 clippedBounds = vec4(
  clamp(outlineBounds.xy, uTroikaClipRect.xy, uTroikaClipRect.zw),
  clamp(outlineBounds.zw, uTroikaClipRect.xy, uTroikaClipRect.zw)
);

vec2 clippedXY = (mix(clippedBounds.xy, clippedBounds.zw, position.xy) - bounds.xy) / (bounds.zw - bounds.xy);

position.xy = mix(bounds.xy, bounds.zw, clippedXY);

uv = (position.xy - uTroikaTotalBounds.xy) / (uTroikaTotalBounds.zw - uTroikaTotalBounds.xy);

float rad = uTroikaCurveRadius;
if (rad != 0.0) {
  float angle = position.x / rad;
  position.xz = vec2(sin(angle) * rad, rad - cos(angle) * rad);
  normal.xz = vec2(sin(angle), cos(angle));
}
  
position = uTroikaOrient * position;
normal = uTroikaOrient * normal;

vTroikaGlyphUV = clippedXY.xy;
vTroikaGlyphDimensions = vec2(bounds[2] - bounds[0], bounds[3] - bounds[1]);

${''/* NOTE: it seems important to calculate the glyph's bounding texture UVs here in the
  vertex shader, rather than in the fragment shader, as the latter gives strange artifacts
  on some glyphs (those in the leftmost texture column) on some systems. The exact reason
  isn't understood but doing this here, then mix()-ing in the fragment shader, seems to work. */}
float txCols = uTroikaSDFTextureSize.x / uTroikaSDFGlyphSize;
vec2 txUvPerSquare = uTroikaSDFGlyphSize / uTroikaSDFTextureSize;
vec2 txStartUV = txUvPerSquare * vec2(
  mod(floor(aTroikaGlyphIndex / 4.0), txCols),
  floor(floor(aTroikaGlyphIndex / 4.0) / txCols)
);
vTroikaTextureUVBounds = vec4(txStartUV, vec2(txStartUV) + txUvPerSquare);
vTroikaTextureChannel = mod(aTroikaGlyphIndex, 4.0);
`;

  // language=GLSL
  const FRAGMENT_DEFS = `
uniform sampler2D uTroikaSDFTexture;
uniform vec2 uTroikaSDFTextureSize;
uniform float uTroikaSDFGlyphSize;
uniform float uTroikaSDFExponent;
uniform float uTroikaDistanceOffset;
uniform float uTroikaFillOpacity;
uniform float uTroikaOutlineOpacity;
uniform float uTroikaBlurRadius;
uniform vec3 uTroikaStrokeColor;
uniform float uTroikaStrokeWidth;
uniform float uTroikaStrokeOpacity;
uniform bool uTroikaSDFDebug;
varying vec2 vTroikaGlyphUV;
varying vec4 vTroikaTextureUVBounds;
varying float vTroikaTextureChannel;
varying vec2 vTroikaGlyphDimensions;

float troikaSdfValueToSignedDistance(float alpha) {
  // Inverse of encoding in SDFGenerator.js
  ${''/* TODO - there's some slight inaccuracy here when dealing with interpolated alpha values; those
    are linearly interpolated where the encoding is exponential. Look into improving this by rounding
    to nearest 2 whole texels, decoding those exponential values, and linearly interpolating the result.
  */}
  float maxDimension = max(vTroikaGlyphDimensions.x, vTroikaGlyphDimensions.y);
  float absDist = (1.0 - pow(2.0 * (alpha > 0.5 ? 1.0 - alpha : alpha), 1.0 / uTroikaSDFExponent)) * maxDimension;
  float signedDist = absDist * (alpha > 0.5 ? -1.0 : 1.0);
  return signedDist;
}

float troikaGlyphUvToSdfValue(vec2 glyphUV) {
  vec2 textureUV = mix(vTroikaTextureUVBounds.xy, vTroikaTextureUVBounds.zw, glyphUV);
  vec4 rgba = texture2D(uTroikaSDFTexture, textureUV);
  float ch = floor(vTroikaTextureChannel + 0.5); //NOTE: can't use round() in WebGL1
  return ch == 0.0 ? rgba.r : ch == 1.0 ? rgba.g : ch == 2.0 ? rgba.b : rgba.a;
}

float troikaGlyphUvToDistance(vec2 uv) {
  return troikaSdfValueToSignedDistance(troikaGlyphUvToSdfValue(uv));
}

float troikaGetAADist() {
  ${''/*
    When the standard derivatives extension is available, we choose an antialiasing alpha threshold based
    on the potential change in the SDF's alpha from this fragment to its neighbor. This strategy maximizes 
    readability and edge crispness at all sizes and screen resolutions.
  */}
  #if defined(GL_OES_standard_derivatives) || __VERSION__ >= 300
  return length(fwidth(vTroikaGlyphUV * vTroikaGlyphDimensions)) * 0.5;
  #else
  return vTroikaGlyphDimensions.x / 64.0;
  #endif
}

float troikaGetFragDistValue() {
  vec2 clampedGlyphUV = clamp(vTroikaGlyphUV, 0.5 / uTroikaSDFGlyphSize, 1.0 - 0.5 / uTroikaSDFGlyphSize);
  float distance = troikaGlyphUvToDistance(clampedGlyphUV);
 
  // Extrapolate distance when outside bounds:
  distance += clampedGlyphUV == vTroikaGlyphUV ? 0.0 : 
    length((vTroikaGlyphUV - clampedGlyphUV) * vTroikaGlyphDimensions);

  ${''/* 
  // TODO more refined extrapolated distance by adjusting for angle of gradient at edge...
  // This has potential but currently gives very jagged extensions, maybe due to precision issues?
  float uvStep = 1.0 / uTroikaSDFGlyphSize;
  vec2 neighbor1UV = clampedGlyphUV + (
    vTroikaGlyphUV.x != clampedGlyphUV.x ? vec2(0.0, uvStep * sign(0.5 - vTroikaGlyphUV.y)) :
    vTroikaGlyphUV.y != clampedGlyphUV.y ? vec2(uvStep * sign(0.5 - vTroikaGlyphUV.x), 0.0) :
    vec2(0.0)
  );
  vec2 neighbor2UV = clampedGlyphUV + (
    vTroikaGlyphUV.x != clampedGlyphUV.x ? vec2(0.0, uvStep * -sign(0.5 - vTroikaGlyphUV.y)) :
    vTroikaGlyphUV.y != clampedGlyphUV.y ? vec2(uvStep * -sign(0.5 - vTroikaGlyphUV.x), 0.0) :
    vec2(0.0)
  );
  float neighbor1Distance = troikaGlyphUvToDistance(neighbor1UV);
  float neighbor2Distance = troikaGlyphUvToDistance(neighbor2UV);
  float distToUnclamped = length((vTroikaGlyphUV - clampedGlyphUV) * vTroikaGlyphDimensions);
  float distToNeighbor = length((clampedGlyphUV - neighbor1UV) * vTroikaGlyphDimensions);
  float gradientAngle1 = min(asin(abs(neighbor1Distance - distance) / distToNeighbor), PI / 2.0);
  float gradientAngle2 = min(asin(abs(neighbor2Distance - distance) / distToNeighbor), PI / 2.0);
  distance += (cos(gradientAngle1) + cos(gradientAngle2)) / 2.0 * distToUnclamped;
  */}

  return distance;
}

float troikaGetEdgeAlpha(float distance, float distanceOffset, float aaDist) {
  #if defined(IS_DEPTH_MATERIAL) || defined(IS_DISTANCE_MATERIAL)
  float alpha = step(-distanceOffset, -distance);
  #else

  float alpha = smoothstep(
    distanceOffset + aaDist,
    distanceOffset - aaDist,
    distance
  );
  #endif

  return alpha;
}
`;

  // language=GLSL prefix="void main() {" suffix="}"
  const FRAGMENT_TRANSFORM = `
float aaDist = troikaGetAADist();
float distance = troikaGetFragDistValue();
float edgeAlpha = uTroikaSDFDebug ?
  troikaGlyphUvToSdfValue(vTroikaGlyphUV) :
  troikaGetEdgeAlpha(distance, uTroikaDistanceOffset, max(aaDist, uTroikaBlurRadius));

#if !defined(IS_DEPTH_MATERIAL) && !defined(IS_DISTANCE_MATERIAL)
vec4 fillRGBA = gl_FragColor;
fillRGBA.a *= uTroikaFillOpacity;
vec4 strokeRGBA = uTroikaStrokeWidth == 0.0 ? fillRGBA : vec4(uTroikaStrokeColor, uTroikaStrokeOpacity);
if (fillRGBA.a == 0.0) fillRGBA.rgb = strokeRGBA.rgb;
gl_FragColor = mix(fillRGBA, strokeRGBA, smoothstep(
  -uTroikaStrokeWidth - aaDist,
  -uTroikaStrokeWidth + aaDist,
  distance
));
gl_FragColor.a *= edgeAlpha;
#endif

if (edgeAlpha == 0.0) {
  discard;
}
`;


  /**
   * Create a material for rendering text, derived from a baseMaterial
   */
  function createTextDerivedMaterial(baseMaterial) {
    const textMaterial = createDerivedMaterial(baseMaterial, {
      chained: true,
      extensions: {
        derivatives: true
      },
      uniforms: {
        uTroikaSDFTexture: {value: null},
        uTroikaSDFTextureSize: {value: new THREE.Vector2()},
        uTroikaSDFGlyphSize: {value: 0},
        uTroikaSDFExponent: {value: 0},
        uTroikaTotalBounds: {value: new THREE.Vector4(0,0,0,0)},
        uTroikaClipRect: {value: new THREE.Vector4(0,0,0,0)},
        uTroikaDistanceOffset: {value: 0},
        uTroikaOutlineOpacity: {value: 0},
        uTroikaFillOpacity: {value: 1},
        uTroikaPositionOffset: {value: new THREE.Vector2()},
        uTroikaCurveRadius: {value: 0},
        uTroikaBlurRadius: {value: 0},
        uTroikaStrokeWidth: {value: 0},
        uTroikaStrokeColor: {value: new THREE.Color()},
        uTroikaStrokeOpacity: {value: 1},
        uTroikaOrient: {value: new THREE.Matrix3()},
        uTroikaUseGlyphColors: {value: true},
        uTroikaSDFDebug: {value: false}
      },
      vertexDefs: VERTEX_DEFS,
      vertexTransform: VERTEX_TRANSFORM,
      fragmentDefs: FRAGMENT_DEFS,
      fragmentColorTransform: FRAGMENT_TRANSFORM,
      customRewriter({vertexShader, fragmentShader}) {
        let uDiffuseRE = /\buniform\s+vec3\s+diffuse\b/;
        if (uDiffuseRE.test(fragmentShader)) {
          // Replace all instances of `diffuse` with our varying
          fragmentShader = fragmentShader
            .replace(uDiffuseRE, 'varying vec3 vTroikaGlyphColor')
            .replace(/\bdiffuse\b/g, 'vTroikaGlyphColor');
          // Make sure the vertex shader declares the uniform so we can grab it as a fallback
          if (!uDiffuseRE.test(vertexShader)) {
            vertexShader = vertexShader.replace(
              voidMainRegExp,
              'uniform vec3 diffuse;\n$&\nvTroikaGlyphColor = uTroikaUseGlyphColors ? aTroikaGlyphColor / 255.0 : diffuse;\n'
            );
          }
        }
        return { vertexShader, fragmentShader }
      }
    });

    // Force transparency - TODO is this reasonable?
    textMaterial.transparent = true;

    Object.defineProperties(textMaterial, {
      isTroikaTextMaterial: {value: true},

      // WebGLShadowMap reverses the side of the shadow material by default, which fails
      // for planes, so here we force the `shadowSide` to always match the main side.
      shadowSide: {
        get() {
          return this.side
        },
        set() {
          //no-op
        }
      }
    });

    return textMaterial
  }

  const Text = /*#__PURE__*/(() => {

    const defaultMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true
    });
    const defaultStrokeColor = 0x808080;

    const tempMat4 = new THREE.Matrix4();
    const tempVec3a = new THREE.Vector3();
    const tempVec3b = new THREE.Vector3();
    const tempArray = [];
    const origin = new THREE.Vector3();
    const defaultOrient = '+x+y';

    function first(o) {
      return Array.isArray(o) ? o[0] : o
    }

    let getFlatRaycastMesh = () => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneBufferGeometry(1, 1),
        defaultMaterial
      );
      getFlatRaycastMesh = () => mesh;
      return mesh
    };
    let getCurvedRaycastMesh = () => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneBufferGeometry(1, 1, 32, 1),
        defaultMaterial
      );
      getCurvedRaycastMesh = () => mesh;
      return mesh
    };

    const syncStartEvent = {type: 'syncstart'};
    const syncCompleteEvent = {type: 'synccomplete'};

    const SYNCABLE_PROPS = [
      'font',
      'fontSize',
      'letterSpacing',
      'lineHeight',
      'maxWidth',
      'overflowWrap',
      'text',
      'direction',
      'textAlign',
      'textIndent',
      'whiteSpace',
      'anchorX',
      'anchorY',
      'colorRanges',
      'sdfGlyphSize'
    ];

    const COPYABLE_PROPS = SYNCABLE_PROPS.concat(
      'material',
      'color',
      'depthOffset',
      'clipRect',
      'curveRadius',
      'orientation',
      'glyphGeometryDetail'
    );



    /**
     * @class Text
     *
     * A ThreeJS Mesh that renders a string of text on a plane in 3D space using signed distance
     * fields (SDF).
     */
    class Text extends THREE.Mesh {
      constructor() {
        const geometry = new GlyphsGeometry();
        super(geometry, null);

        // === Text layout properties: === //

        /**
         * @member {string} text
         * The string of text to be rendered.
         */
        this.text = '';

        /**
         * @deprecated Use `anchorX` and `anchorY` instead
         * @member {Array<number>} anchor
         * Defines where in the text block should correspond to the mesh's local position, as a set
         * of horizontal and vertical percentages from 0 to 1. A value of `[0, 0]` (the default)
         * anchors at the top-left, `[1, 1]` at the bottom-right, and `[0.5, 0.5]` centers the
         * block at the mesh's position.
         */
        //this.anchor = null

        /**
         * @member {number|string} anchorX
         * Defines the horizontal position in the text block that should line up with the local origin.
         * Can be specified as a numeric x position in local units, a string percentage of the total
         * text block width e.g. `'25%'`, or one of the following keyword strings: 'left', 'center',
         * or 'right'.
         */
        this.anchorX = 0;

        /**
         * @member {number|string} anchorX
         * Defines the vertical position in the text block that should line up with the local origin.
         * Can be specified as a numeric y position in local units (note: down is negative y), a string
         * percentage of the total text block height e.g. `'25%'`, or one of the following keyword strings:
         * 'top', 'top-baseline', 'middle', 'bottom-baseline', or 'bottom'.
         */
        this.anchorY = 0;

        /**
         * @member {number} curveRadius
         * Defines a cylindrical radius along which the text's plane will be curved. Positive numbers put
         * the cylinder's centerline (oriented vertically) that distance in front of the text, for a concave
         * curvature, while negative numbers put it behind the text for a convex curvature. The centerline
         * will be aligned with the text's local origin; you can use `anchorX` to offset it.
         *
         * Since each glyph is by default rendered with a simple quad, each glyph remains a flat plane
         * internally. You can use `glyphGeometryDetail` to add more vertices for curvature inside glyphs.
         */
        this.curveRadius = 0;

        /**
         * @member {string} direction
         * Sets the base direction for the text. The default value of "auto" will choose a direction based
         * on the text's content according to the bidi spec. A value of "ltr" or "rtl" will force the direction.
         */
        this.direction = 'auto';

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
         * @member {number} textIndent
         * Indentation for the first character of a line; see CSS `text-indent`.
         */
        this.textIndent = 0;

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
         * if you don't want to specify a whole custom `material`. Also, if you do use a custom
         * `material`, this color will only be used for this particuar Text instance, even if
         * that same material instance is shared across multiple Text objects.
         */
        this.color = null;

        /**
         * @member {object|null} colorRanges
         * WARNING: This API is experimental and may change.
         * This allows more fine-grained control of colors for individual or ranges of characters,
         * taking precedence over the material's `color`. Its format is an Object whose keys each
         * define a starting character index for a range, and whose values are the color for each
         * range. The color value can be a numeric hex color value, a `THREE.Color` object, or
         * any of the strings accepted by `THREE.Color`.
         */
        this.colorRanges = null;

        /**
         * @member {number|string} outlineWidth
         * WARNING: This API is experimental and may change.
         * The width of an outline/halo to be drawn around each text glyph using the `outlineColor` and `outlineOpacity`.
         * Can be specified as either an absolute number in local units, or as a percentage string e.g.
         * `"12%"` which is treated as a percentage of the `fontSize`. Defaults to `0`, which means
         * no outline will be drawn unless an `outlineOffsetX/Y` or `outlineBlur` is set.
         */
        this.outlineWidth = 0;

        /**
         * @member {string|number|THREE.Color} outlineColor
         * WARNING: This API is experimental and may change.
         * The color of the text outline, if `outlineWidth`/`outlineBlur`/`outlineOffsetX/Y` are set.
         * Defaults to black.
         */
        this.outlineColor = 0x000000;

        /**
         * @member {number} outlineOpacity
         * WARNING: This API is experimental and may change.
         * The opacity of the outline, if `outlineWidth`/`outlineBlur`/`outlineOffsetX/Y` are set.
         * Defaults to `1`.
         */
        this.outlineOpacity = 1;

        /**
         * @member {number|string} outlineBlur
         * WARNING: This API is experimental and may change.
         * A blur radius applied to the outer edge of the text's outline. If the `outlineWidth` is
         * zero, the blur will be applied at the glyph edge, like CSS's `text-shadow` blur radius.
         * Can be specified as either an absolute number in local units, or as a percentage string e.g.
         * `"12%"` which is treated as a percentage of the `fontSize`. Defaults to `0`.
         */
        this.outlineBlur = 0;

        /**
         * @member {number|string} outlineOffsetX
         * WARNING: This API is experimental and may change.
         * A horizontal offset for the text outline.
         * Can be specified as either an absolute number in local units, or as a percentage string e.g. `"12%"`
         * which is treated as a percentage of the `fontSize`. Defaults to `0`.
         */
        this.outlineOffsetX = 0;

        /**
         * @member {number|string} outlineOffsetY
         * WARNING: This API is experimental and may change.
         * A vertical offset for the text outline.
         * Can be specified as either an absolute number in local units, or as a percentage string e.g. `"12%"`
         * which is treated as a percentage of the `fontSize`. Defaults to `0`.
         */
        this.outlineOffsetY = 0;

        /**
         * @member {number|string} strokeWidth
         * WARNING: This API is experimental and may change.
         * The width of an inner stroke drawn inside each text glyph using the `strokeColor` and `strokeOpacity`.
         * Can be specified as either an absolute number in local units, or as a percentage string e.g. `"12%"`
         * which is treated as a percentage of the `fontSize`. Defaults to `0`.
         */
        this.strokeWidth = 0;

        /**
         * @member {string|number|THREE.Color} strokeColor
         * WARNING: This API is experimental and may change.
         * The color of the text stroke, if `strokeWidth` is greater than zero. Defaults to gray.
         */
        this.strokeColor = defaultStrokeColor;

        /**
         * @member {number} strokeOpacity
         * WARNING: This API is experimental and may change.
         * The opacity of the stroke, if `strokeWidth` is greater than zero. Defaults to `1`.
         */
        this.strokeOpacity = 1;

        /**
         * @member {number} fillOpacity
         * WARNING: This API is experimental and may change.
         * The opacity of the glyph's fill from 0 to 1. This behaves like the material's `opacity` but allows
         * giving the fill a different opacity than the `strokeOpacity`. A fillOpacity of `0` makes the
         * interior of the glyph invisible, leaving just the `strokeWidth`. Defaults to `1`.
         */
        this.fillOpacity = 1;

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

        /**
         * @member {string} orientation
         * Defines the axis plane on which the text should be laid out when the mesh has no extra
         * rotation transform. It is specified as a string with two axes: the horizontal axis with
         * positive pointing right, and the vertical axis with positive pointing up. By default this
         * is '+x+y', meaning the text sits on the xy plane with the text's top toward positive y
         * and facing positive z. A value of '+x-z' would place it on the xz plane with the text's
         * top toward negative z and facing positive y.
         */
        this.orientation = defaultOrient;

        /**
         * @member {number} glyphGeometryDetail
         * Controls number of vertical/horizontal segments that make up each glyph's rectangular
         * plane. Defaults to 1. This can be increased to provide more geometrical detail for custom
         * vertex shader effects, for example.
         */
        this.glyphGeometryDetail = 1;

        /**
         * @member {number|null} sdfGlyphSize
         * The size of each glyph's SDF (signed distance field) used for rendering. This must be a
         * power-of-two number. Defaults to 64 which is generally a good balance of size and quality
         * for most fonts. Larger sizes can improve the quality of glyph rendering by increasing
         * the sharpness of corners and preventing loss of very thin lines, at the expense of
         * increased memory footprint and longer SDF generation time.
         */
        this.sdfGlyphSize = null;

        this.debugSDF = false;
      }

      /**
       * Updates the text rendering according to the current text-related configuration properties.
       * This is an async process, so you can pass in a callback function to be executed when it
       * finishes.
       * @param {function} [callback]
       */
      sync(callback) {
        if (this._needsSync) {
          this._needsSync = false;

          // If there's another sync still in progress, queue
          if (this._isSyncing) {
            (this._queuedSyncs || (this._queuedSyncs = [])).push(callback);
          } else {
            this._isSyncing = true;
            this.dispatchEvent(syncStartEvent);

            getTextRenderInfo({
              text: this.text,
              font: this.font,
              fontSize: this.fontSize || 0.1,
              letterSpacing: this.letterSpacing || 0,
              lineHeight: this.lineHeight || 'normal',
              maxWidth: this.maxWidth,
              direction: this.direction || 'auto',
              textAlign: this.textAlign,
              textIndent: this.textIndent,
              whiteSpace: this.whiteSpace,
              overflowWrap: this.overflowWrap,
              anchorX: this.anchorX,
              anchorY: this.anchorY,
              colorRanges: this.colorRanges,
              includeCaretPositions: true, //TODO parameterize
              sdfGlyphSize: this.sdfGlyphSize
            }, textRenderInfo => {
              this._isSyncing = false;

              // Save result for later use in onBeforeRender
              this._textRenderInfo = textRenderInfo;

              // Update the geometry attributes
              this.geometry.updateGlyphs(
                textRenderInfo.glyphBounds,
                textRenderInfo.glyphAtlasIndices,
                textRenderInfo.blockBounds,
                textRenderInfo.chunkedBounds,
                textRenderInfo.glyphColors
              );

              // If we had extra sync requests queued up, kick it off
              const queued = this._queuedSyncs;
              if (queued) {
                this._queuedSyncs = null;
                this._needsSync = true;
                this.sync(() => {
                  queued.forEach(fn => fn && fn());
                });
              }

              this.dispatchEvent(syncCompleteEvent);
              if (callback) {
                callback();
              }
            });
          }
        }
      }

      /**
       * Initiate a sync if needed - note it won't complete until next frame at the
       * earliest so if possible it's a good idea to call sync() manually as soon as
       * all the properties have been set.
       * @override
       */
      onBeforeRender(renderer, scene, camera, geometry, material, group) {
        this.sync();

        // This may not always be a text material, e.g. if there's a scene.overrideMaterial present
        if (material.isTroikaTextMaterial) {
          this._prepareForRender(material);
        }
      }

      /**
       * Shortcut to dispose the geometry specific to this instance.
       * Note: we don't also dispose the derived material here because if anything else is
       * sharing the same base material it will result in a pause next frame as the program
       * is recompiled. Instead users can dispose the base material manually, like normal,
       * and we'll also dispose the derived material at that time.
       */
      dispose() {
        this.geometry.dispose();
      }

      /**
       * @property {TroikaTextRenderInfo|null} textRenderInfo
       * @readonly
       * The current processed rendering data for this TextMesh, returned by the TextBuilder after
       * a `sync()` call. This will be `null` initially, and may be stale for a short period until
       * the asynchrous `sync()` process completes.
       */
      get textRenderInfo() {
        return this._textRenderInfo || null
      }

      // Handler for automatically wrapping the base material with our upgrades. We do the wrapping
      // lazily on _read_ rather than write to avoid unnecessary wrapping on transient values.
      get material() {
        let derivedMaterial = this._derivedMaterial;
        const baseMaterial = this._baseMaterial || this._defaultMaterial || (this._defaultMaterial = defaultMaterial.clone());
        if (!derivedMaterial || derivedMaterial.baseMaterial !== baseMaterial) {
          derivedMaterial = this._derivedMaterial = createTextDerivedMaterial(baseMaterial);
          // dispose the derived material when its base material is disposed:
          baseMaterial.addEventListener('dispose', function onDispose() {
            baseMaterial.removeEventListener('dispose', onDispose);
            derivedMaterial.dispose();
          });
        }
        // If text outline is configured, render it as a preliminary draw using Three's multi-material
        // feature (see GlyphsGeometry which sets up `groups` for this purpose) Doing it with multi
        // materials ensures the layers are always rendered consecutively in a consistent order.
        // Each layer will trigger onBeforeRender with the appropriate material.
        if (this.outlineWidth || this.outlineBlur || this.outlineOffsetX || this.outlineOffsetY) {
          let outlineMaterial = derivedMaterial._outlineMtl;
          if (!outlineMaterial) {
            outlineMaterial = derivedMaterial._outlineMtl = Object.create(derivedMaterial, {
              id: {value: derivedMaterial.id + 0.1}
            });
            outlineMaterial.isTextOutlineMaterial = true;
            outlineMaterial.depthWrite = false;
            outlineMaterial.map = null; //???
            derivedMaterial.addEventListener('dispose', function onDispose() {
              derivedMaterial.removeEventListener('dispose', onDispose);
              outlineMaterial.dispose();
            });
          }
          return [
            outlineMaterial,
            derivedMaterial
          ]
        } else {
          return derivedMaterial
        }
      }
      set material(baseMaterial) {
        if (baseMaterial && baseMaterial.isTroikaTextMaterial) { //prevent double-derivation
          this._derivedMaterial = baseMaterial;
          this._baseMaterial = baseMaterial.baseMaterial;
        } else {
          this._baseMaterial = baseMaterial;
        }
      }

      get glyphGeometryDetail() {
        return this.geometry.detail
      }
      set glyphGeometryDetail(detail) {
        this.geometry.detail = detail;
      }

      get curveRadius() {
        return this.geometry.curveRadius
      }
      set curveRadius(r) {
        this.geometry.curveRadius = r;
      }

      // Create and update material for shadows upon request:
      get customDepthMaterial() {
        return first(this.material).getDepthMaterial()
      }
      get customDistanceMaterial() {
        return first(this.material).getDistanceMaterial()
      }

      _prepareForRender(material) {
        const isOutline = material.isTextOutlineMaterial;
        const uniforms = material.uniforms;
        const textInfo = this.textRenderInfo;
        if (textInfo) {
          const {sdfTexture, blockBounds} = textInfo;
          uniforms.uTroikaSDFTexture.value = sdfTexture;
          uniforms.uTroikaSDFTextureSize.value.set(sdfTexture.image.width, sdfTexture.image.height);
          uniforms.uTroikaSDFGlyphSize.value = textInfo.sdfGlyphSize;
          uniforms.uTroikaSDFExponent.value = textInfo.sdfExponent;
          uniforms.uTroikaTotalBounds.value.fromArray(blockBounds);
          uniforms.uTroikaUseGlyphColors.value = !isOutline && !!textInfo.glyphColors;

          let distanceOffset = 0;
          let blurRadius = 0;
          let strokeWidth = 0;
          let fillOpacity;
          let strokeOpacity;
          let strokeColor;
          let offsetX = 0;
          let offsetY = 0;

          if (isOutline) {
            let {outlineWidth, outlineOffsetX, outlineOffsetY, outlineBlur, outlineOpacity} = this;
            distanceOffset = this._parsePercent(outlineWidth) || 0;
            blurRadius = Math.max(0, this._parsePercent(outlineBlur) || 0);
            fillOpacity = outlineOpacity;
            offsetX = this._parsePercent(outlineOffsetX) || 0;
            offsetY = this._parsePercent(outlineOffsetY) || 0;
          } else {
            strokeWidth = Math.max(0, this._parsePercent(this.strokeWidth) || 0);
            if (strokeWidth) {
              strokeColor = this.strokeColor;
              uniforms.uTroikaStrokeColor.value.set(strokeColor == null ? defaultStrokeColor : strokeColor);
              strokeOpacity = this.strokeOpacity;
              if (strokeOpacity == null) strokeOpacity = 1;
            }
            fillOpacity = this.fillOpacity;
          }

          uniforms.uTroikaDistanceOffset.value = distanceOffset;
          uniforms.uTroikaPositionOffset.value.set(offsetX, offsetY);
          uniforms.uTroikaBlurRadius.value = blurRadius;
          uniforms.uTroikaStrokeWidth.value = strokeWidth;
          uniforms.uTroikaStrokeOpacity.value = strokeOpacity;
          uniforms.uTroikaFillOpacity.value = fillOpacity == null ? 1 : fillOpacity;
          uniforms.uTroikaCurveRadius.value = this.curveRadius || 0;

          let clipRect = this.clipRect;
          if (clipRect && Array.isArray(clipRect) && clipRect.length === 4) {
            uniforms.uTroikaClipRect.value.fromArray(clipRect);
          } else {
            // no clipping - choose a finite rect that shouldn't ever be reached by overflowing glyphs or outlines
            const pad = (this.fontSize || 0.1) * 100;
            uniforms.uTroikaClipRect.value.set(
              blockBounds[0] - pad,
              blockBounds[1] - pad,
              blockBounds[2] + pad,
              blockBounds[3] + pad
            );
          }
          this.geometry.applyClipRect(uniforms.uTroikaClipRect.value);
        }
        uniforms.uTroikaSDFDebug.value = !!this.debugSDF;
        material.polygonOffset = !!this.depthOffset;
        material.polygonOffsetFactor = material.polygonOffsetUnits = this.depthOffset || 0;

        // Shortcut for setting material color via `color` prop on the mesh; this is
        // applied only to the derived material to avoid mutating a shared base material.
        const color = isOutline ? (this.outlineColor || 0) : this.color;

        if (color == null) {
          delete material.color; //inherit from base
        } else {
          const colorObj = material.hasOwnProperty('color') ? material.color : (material.color = new THREE.Color());
          if (color !== colorObj._input || typeof color === 'object') {
            colorObj.set(colorObj._input = color);
          }
        }

        // base orientation
        let orient = this.orientation || defaultOrient;
        if (orient !== material._orientation) {
          let rotMat = uniforms.uTroikaOrient.value;
          orient = orient.replace(/[^-+xyz]/g, '');
          let match = orient !== defaultOrient && orient.match(/^([-+])([xyz])([-+])([xyz])$/);
          if (match) {
            let [, hSign, hAxis, vSign, vAxis] = match;
            tempVec3a.set(0, 0, 0)[hAxis] = hSign === '-' ? 1 : -1;
            tempVec3b.set(0, 0, 0)[vAxis] = vSign === '-' ? -1 : 1;
            tempMat4.lookAt(origin, tempVec3a.cross(tempVec3b), tempVec3b);
            rotMat.setFromMatrix4(tempMat4);
          } else {
            rotMat.identity();
          }
          material._orientation = orient;
        }
      }

      _parsePercent(value) {
        if (typeof value === 'string') {
          let match = value.match(/^(-?[\d.]+)%$/);
          let pct = match ? parseFloat(match[1]) : NaN;
          value = (isNaN(pct) ? 0 : pct / 100) * this.fontSize;
        }
        return value
      }

      /**
       * Translate a point in local space to an x/y in the text plane.
       */
      localPositionToTextCoords(position, target = new THREE.Vector2()) {
        target.copy(position); //simple non-curved case is 1:1
        const r = this.curveRadius;
        if (r) { //flatten the curve
          target.x = Math.atan2(position.x, Math.abs(r) - Math.abs(position.z)) * Math.abs(r);
        }
        return target
      }

      /**
       * Translate a point in world space to an x/y in the text plane.
       */
      worldPositionToTextCoords(position, target = new THREE.Vector2()) {
        tempVec3a.copy(position);
        return this.localPositionToTextCoords(this.worldToLocal(tempVec3a), target)
      }

      /**
       * @override Custom raycasting to test against the whole text block's max rectangular bounds
       * TODO is there any reason to make this more granular, like within individual line or glyph rects?
       */
      raycast(raycaster, intersects) {
        const {textRenderInfo, curveRadius} = this;
        if (textRenderInfo) {
          const bounds = textRenderInfo.blockBounds;
          const raycastMesh = curveRadius ? getCurvedRaycastMesh() : getFlatRaycastMesh();
          const geom = raycastMesh.geometry;
          const {position, uv} = geom.attributes;
          for (let i = 0; i < uv.count; i++) {
            let x = bounds[0] + (uv.getX(i) * (bounds[2] - bounds[0]));
            const y = bounds[1] + (uv.getY(i) * (bounds[3] - bounds[1]));
            let z = 0;
            if (curveRadius) {
              z = curveRadius - Math.cos(x / curveRadius) * curveRadius;
              x = Math.sin(x / curveRadius) * curveRadius;
            }
            position.setXYZ(i, x, y, z);
          }
          geom.boundingSphere = this.geometry.boundingSphere;
          geom.boundingBox = this.geometry.boundingBox;
          raycastMesh.matrixWorld = this.matrixWorld;
          raycastMesh.material.side = this.material.side;
          tempArray.length = 0;
          raycastMesh.raycast(raycaster, tempArray);
          for (let i = 0; i < tempArray.length; i++) {
            tempArray[i].object = this;
            intersects.push(tempArray[i]);
          }
        }
      }

      copy(source) {
        // Prevent copying the geometry reference so we don't end up sharing attributes between instances
        const geom = this.geometry;
        super.copy(source);
        this.geometry = geom;

        COPYABLE_PROPS.forEach(prop => {
          this[prop] = source[prop];
        });
        return this
      }

      clone() {
        return new this.constructor().copy(this)
      }
    }


    // Create setters for properties that affect text layout:
    SYNCABLE_PROPS.forEach(prop => {
      const privateKey = '_private_' + prop;
      Object.defineProperty(Text.prototype, prop, {
        get() {
          return this[privateKey]
        },
        set(value) {
          if (value !== this[privateKey]) {
            this[privateKey] = value;
            this._needsSync = true;
          }
        }
      });
    });


    // Deprecation handler for `anchor` array:
    let deprMsgShown = false;
    Object.defineProperty(Text.prototype, 'anchor', {
      get() {
        return this._deprecated_anchor
      },
      set(val) {
        this._deprecated_anchor = val;
        if (!deprMsgShown) {
          console.warn('TextMesh: `anchor` has been deprecated; use `anchorX` and `anchorY` instead.');
          deprMsgShown = true;
        }
        if (Array.isArray(val)) {
          this.anchorX = `${(+val[0] || 0) * 100}%`;
          this.anchorY = `${(+val[1] || 0) * 100}%`;
        } else {
          this.anchorX = this.anchorY = 0;
        }
      }
    });

    return Text
  })();

  var COMPONENT_NAME = 'troika-text';

  function numberOrPercent(defaultValue) {
    return {
      default: defaultValue,
      parse: function(value) {
        if (typeof value === 'string' && value.indexOf('%') > 0) {
          return value
        }
        value = +value;
        return isNaN(value) ? 0 : value
      },
      stringify: function(value) {
        return '' + value
      }
    }
  }

  aframe__default['default'].registerComponent(COMPONENT_NAME, {
    schema: {
      align: {type: 'string', default: 'left', oneOf: ['left', 'right', 'center', 'justify']},
      anchor: {default: 'center', oneOf: ['left', 'right', 'center', 'align']},
      baseline: {default: 'center', oneOf: ['top', 'center', 'bottom']},
      clipRect: {
        type: 'string',
        default: '',
        parse: function(value) {
          if (value) {
            value = value.split(/[\s,]+/).reduce(function(out, val) {
              val = +val;
              if (!isNaN(val)) {
                out.push(val);
              }
              return out
            }, []);
          }
          return value && value.length === 4 ? value : null
        },
        stringify: function(value) {
          return value ? value.join(' ') : ''
        }
      },
      color: {type: 'color', default: '#FFF'},
      curveRadius: {type: 'number', default: 0},
      depthOffset: {type: 'number', default: 0},
      direction: {type: 'string', default: 'auto', oneOf: ['auto', 'ltr', 'rtl']},
      fillOpacity: {type: 'number', default: 1},
      font: {type: 'string'},
      fontSize: {type: 'number', default: 0.2},
      letterSpacing: {type: 'number', default: 0},
      lineHeight: {type: 'number'},
      maxWidth: {type: 'number', default: Infinity},
      outlineBlur: numberOrPercent(0),
      outlineColor: {type: 'color', default: '#000'},
      outlineOffsetX: numberOrPercent(0),
      outlineOffsetY: numberOrPercent(0),
      outlineOpacity: {type: 'number', default: 1},
      outlineWidth: numberOrPercent(0),
      overflowWrap: {type: 'string', default: 'normal', oneOf: ['normal', 'break-word']},
      strokeColor: {type: 'color', default: 'grey'},
      strokeOpacity: {type: 'number', default: 1},
      strokeWidth: numberOrPercent(0),
      textIndent: {type: 'number', default: 0},
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

      // Create Text mesh and add it to the entity as the 'mesh' object
      var textMesh = this.troikaTextMesh = new Text();
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
      mesh.text = (data.value || '')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t');
      mesh.textAlign = data.align;

      mesh.anchorX = anchorMapping[data.anchor === 'align' ? data.align : data.anchor] || 'center';
      mesh.anchorY = baselineMapping[data.baseline] || 'middle';
      mesh.color = data.color;
      mesh.clipRect = data.clipRect;
      mesh.curveRadius = data.curveRadius;
      mesh.depthOffset = data.depthOffset || 0;
      mesh.direction = data.direction;
      mesh.fillOpacity = data.fillOpacity;
      mesh.font = data.font; //TODO allow aframe stock font names
      mesh.fontSize = data.fontSize;
      mesh.letterSpacing = data.letterSpacing || 0;
      mesh.lineHeight = data.lineHeight || 'normal';
      mesh.outlineBlur = data.outlineBlur;
      mesh.outlineColor = data.outlineColor;
      mesh.outlineOffsetX = data.outlineOffsetX;
      mesh.outlineOffsetY = data.outlineOffsetY;
      mesh.outlineOpacity = data.outlineOpacity;
      mesh.outlineWidth = data.outlineWidth;
      mesh.overflowWrap = data.overflowWrap;
      mesh.strokeColor = data.strokeColor;
      mesh.strokeOpacity = data.strokeOpacity;
      mesh.strokeWidth = data.strokeWidth;
      mesh.textIndent = data.textIndent;
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
    'left': 'left',
    'center': 'center',
    'right': 'right'
  };
  var baselineMapping = {
    'top': 'top',
    'center': 'middle',
    'bottom': 'bottom'
  };

  var mappings = {};

  // From aframe's primitives.js utilities...
  var schema = aframe__default['default'].components[COMPONENT_NAME].schema;
  Object.keys(schema).map(function (prop) {
    // Hyphenate where there is camelCase.
    var attrName = prop.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    mappings[attrName] = COMPONENT_NAME + '.' + prop;
  });


  aframe__default['default'].registerPrimitive('a-troika-text', {
    defaultComponents: {
      'troika-text': {}
    },
    mappings: mappings
  });

  // Polyfill Three's rename of Math->MathUtils after the super-three fork
  (function(ThreedleDum) {
    if (!ThreedleDum.MathUtils) {
      ThreedleDum.MathUtils = ThreedleDum.Math;
    }
  })(THREE__namespace);

}(THREE, AFRAME));
