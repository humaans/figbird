"use strict";
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "fetch", {
    enumerable: true,
    get: function() {
        return fetch;
    }
});
var _helpers = require("./helpers");
function _array_like_to_array(arr, len) {
    if (len == null || len > arr.length) len = arr.length;
    for(var i = 0, arr2 = new Array(len); i < len; i++)arr2[i] = arr[i];
    return arr2;
}
function _array_with_holes(arr) {
    if (Array.isArray(arr)) return arr;
}
function _define_property(obj, key, value) {
    if (key in obj) {
        Object.defineProperty(obj, key, {
            value: value,
            enumerable: true,
            configurable: true,
            writable: true
        });
    } else {
        obj[key] = value;
    }
    return obj;
}
function _iterable_to_array_limit(arr, i) {
    var _i = arr == null ? null : typeof Symbol !== "undefined" && arr[Symbol.iterator] || arr["@@iterator"];
    if (_i == null) return;
    var _arr = [];
    var _n = true;
    var _d = false;
    var _s, _e;
    try {
        for(_i = _i.call(arr); !(_n = (_s = _i.next()).done); _n = true){
            _arr.push(_s.value);
            if (i && _arr.length === i) break;
        }
    } catch (err) {
        _d = true;
        _e = err;
    } finally{
        try {
            if (!_n && _i["return"] != null) _i["return"]();
        } finally{
            if (_d) throw _e;
        }
    }
    return _arr;
}
function _non_iterable_rest() {
    throw new TypeError("Invalid attempt to destructure non-iterable instance.\\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
}
function _object_spread(target) {
    for(var i = 1; i < arguments.length; i++){
        var source = arguments[i] != null ? arguments[i] : {};
        var ownKeys = Object.keys(source);
        if (typeof Object.getOwnPropertySymbols === "function") {
            ownKeys = ownKeys.concat(Object.getOwnPropertySymbols(source).filter(function(sym) {
                return Object.getOwnPropertyDescriptor(source, sym).enumerable;
            }));
        }
        ownKeys.forEach(function(key) {
            _define_property(target, key, source[key]);
        });
    }
    return target;
}
function ownKeys(object, enumerableOnly) {
    var keys = Object.keys(object);
    if (Object.getOwnPropertySymbols) {
        var symbols = Object.getOwnPropertySymbols(object);
        if (enumerableOnly) {
            symbols = symbols.filter(function(sym) {
                return Object.getOwnPropertyDescriptor(object, sym).enumerable;
            });
        }
        keys.push.apply(keys, symbols);
    }
    return keys;
}
function _object_spread_props(target, source) {
    source = source != null ? source : {};
    if (Object.getOwnPropertyDescriptors) {
        Object.defineProperties(target, Object.getOwnPropertyDescriptors(source));
    } else {
        ownKeys(Object(source)).forEach(function(key) {
            Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key));
        });
    }
    return target;
}
function _sliced_to_array(arr, i) {
    return _array_with_holes(arr) || _iterable_to_array_limit(arr, i) || _unsupported_iterable_to_array(arr, i) || _non_iterable_rest();
}
function _unsupported_iterable_to_array(o, minLen) {
    if (!o) return;
    if (typeof o === "string") return _array_like_to_array(o, minLen);
    var n = Object.prototype.toString.call(o).slice(8, -1);
    if (n === "Object" && o.constructor) n = o.constructor.name;
    if (n === "Map" || n === "Set") return Array.from(n);
    if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return _array_like_to_array(o, minLen);
}
var get = (0, _helpers.inflight)(function(service, id, params, options) {
    return "".concat(service.path, "/").concat(options.queryId);
}, getter);
var find = (0, _helpers.inflight)(function(service, params, options) {
    return "".concat(service.path, "/").concat(options.queryId);
}, finder);
function fetch(feathers, serviceName, method, id, params, param) {
    var queryId = param.queryId, allPages = param.allPages, parallel = param.parallel;
    var service = feathers.service(serviceName);
    return method === "get" ? get(service, id, params, {
        queryId: queryId
    }) : find(service, params, {
        queryId: queryId,
        allPages: allPages,
        parallel: parallel
    });
}
function getter(service, id, params) {
    return service.get(id, params);
}
function finder(service, params, param) {
    var queryId = param.queryId, allPages = param.allPages, parallel = param.parallel;
    if (!allPages) {
        return service.find(params);
    }
    return new Promise(function(resolve, reject) {
        var doFind = function doFind(skip) {
            return service.find(_object_spread_props(_object_spread({}, params), {
                query: _object_spread_props(_object_spread({}, params.query || {}), {
                    $skip: skip
                })
            }));
        };
        var resolveOrFetchNext = function resolveOrFetchNext(res) {
            if (res.data.length === 0 || result.data.length >= result.total) {
                resolve(result);
            } else {
                skip = result.data.length;
                fetchNext();
            }
        };
        var fetchNextParallel = function fetchNextParallel() {
            var requiredFetches = Math.ceil((result.total - result.data.length) / result.limit);
            if (requiredFetches > 0) {
                Promise.all(new Array(requiredFetches).fill().map(function(_, idx) {
                    return doFind(skip + idx * result.limit);
                })).then(function(results) {
                    var _results_slice = _sliced_to_array(results.slice(-1), 1), lastResult = _results_slice[0];
                    result.limit = lastResult.limit;
                    result.total = lastResult.total;
                    result.data = result.data.concat(results.flatMap(function(r) {
                        return r.data;
                    }));
                    resolveOrFetchNext(lastResult);
                }).catch(reject);
            } else {
                resolve(result);
            }
        };
        var fetchNext = function fetchNext() {
            if (typeof result.total !== "undefined" && typeof result.limit !== "undefined" && parallel === true) {
                fetchNextParallel();
            } else {
                doFind(skip).then(function(res) {
                    result.limit = res.limit;
                    result.total = res.total;
                    result.data = result.data.concat(res.data);
                    resolveOrFetchNext(res);
                }).catch(reject);
            }
        };
        var skip = 0;
        var result = {
            data: [],
            skip: 0
        };
        fetchNext();
    });
}
