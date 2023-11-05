"use strict";
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "useQuery", {
    enumerable: true,
    get: function() {
        return useQuery;
    }
});
var _react = require("react");
var _core = require("./core");
var _useRealtime = require("./useRealtime");
var _useCache = require("./useCache");
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
function _object_without_properties(source, excluded) {
    if (source == null) return {};
    var target = _object_without_properties_loose(source, excluded);
    var key, i;
    if (Object.getOwnPropertySymbols) {
        var sourceSymbolKeys = Object.getOwnPropertySymbols(source);
        for(i = 0; i < sourceSymbolKeys.length; i++){
            key = sourceSymbolKeys[i];
            if (excluded.indexOf(key) >= 0) continue;
            if (!Object.prototype.propertyIsEnumerable.call(source, key)) continue;
            target[key] = source[key];
        }
    }
    return target;
}
function _object_without_properties_loose(source, excluded) {
    if (source == null) return {};
    var target = {};
    var sourceKeys = Object.keys(source);
    var key, i;
    for(i = 0; i < sourceKeys.length; i++){
        key = sourceKeys[i];
        if (excluded.indexOf(key) >= 0) continue;
        target[key] = source[key];
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
var fetchPolicies = [
    "swr",
    "cache-first",
    "network-only"
];
var realtimeModes = [
    "merge",
    "refetch",
    "disabled"
];
function useQuery(serviceName) {
    var options = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : {}, queryHookOptions = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : {};
    var method = queryHookOptions.method, id = queryHookOptions.id, selectData = queryHookOptions.selectData, transformResponse = queryHookOptions.transformResponse;
    var feathers = (0, _core.useFigbird)().feathers;
    var disposed = (0, _react.useRef)(false);
    var isInitialMount = (0, _react.useRef)(true);
    var skip = options.skip, allPages = options.allPages, parallel = options.parallel, _options_realtime = options.realtime, realtime = _options_realtime === void 0 ? "merge" : _options_realtime, _options_fetchPolicy = options.fetchPolicy, fetchPolicy = _options_fetchPolicy === void 0 ? "swr" : _options_fetchPolicy, matcher = options.matcher, params = _object_without_properties(options, [
        "skip",
        "allPages",
        "parallel",
        "realtime",
        "fetchPolicy",
        "matcher"
    ]);
    realtime = realtime || "disabled";
    if (realtime !== "disabled" && realtime !== "merge" && realtime !== "refetch") {
        throw new Error("Bad realtime option, must be one of ".concat([
            realtimeModes
        ].join(", ")));
    }
    if (!fetchPolicies.includes(fetchPolicy)) {
        throw new Error("Bad fetchPolicy option, must be one of ".concat([
            fetchPolicies
        ].join(", ")));
    }
    var queryId = "".concat(method.substr(0, 1), ":").concat((0, _helpers.hashObject)({
        serviceName: serviceName,
        method: method,
        id: id,
        params: params,
        realtime: realtime
    }));
    var _useCache1 = _sliced_to_array((0, _useCache.useCache)({
        serviceName: serviceName,
        queryId: queryId,
        method: method,
        id: id,
        params: params,
        realtime: realtime,
        selectData: selectData,
        transformResponse: transformResponse,
        matcher: matcher
    }), 2), cachedData = _useCache1[0], updateCache = _useCache1[1];
    var hasCachedData = !!cachedData.data;
    var fetched = fetchPolicy === "cache-first" && hasCachedData;
    var _useReducer = _sliced_to_array((0, _react.useReducer)(reducer, {
        reloading: false,
        fetched: fetched,
        fetchedCount: 0,
        refetchSeq: 0,
        error: null
    }), 2), state = _useReducer[0], dispatch = _useReducer[1];
    if (fetchPolicy === "network-only" && state.fetchedCount === 0) {
        cachedData = {
            data: null
        };
        hasCachedData = false;
    }
    var handleRealtimeEvent = (0, _react.useCallback)(function(payload) {
        if (disposed.current) return;
        if (realtime !== "refetch") return;
        dispatch({
            type: "refetch"
        });
    }, [
        dispatch,
        realtime,
        disposed
    ]);
    (0, _react.useEffect)(function() {
        return function() {
            disposed.current = true;
        };
    }, []);
    (0, _react.useEffect)(function() {
        var disposed = false;
        if (state.fetched) return;
        if (skip) return;
        dispatch({
            type: "fetching"
        });
        var service = feathers.service(serviceName);
        var result = method === "get" ? get(service, id, params, {
            queryId: queryId
        }) : find(service, params, {
            queryId: queryId,
            allPages: allPages,
            parallel: parallel
        });
        result.then(function(res) {
            // no res means we've piggy backed on an in flight request
            if (res) {
                updateCache(res);
            }
            if (!disposed) {
                dispatch({
                    type: "success"
                });
            }
        }).catch(function(err) {
            if (!disposed) {
                dispatch({
                    type: "error",
                    payload: err
                });
            }
        });
        return function() {
            disposed = true;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        serviceName,
        queryId,
        state.fetched,
        state.refetchSeq,
        skip,
        allPages,
        parallel
    ]);
    // If serviceName or queryId changed, we should refetch the data
    (0, _react.useEffect)(function() {
        if (!isInitialMount.current) {
            dispatch({
                type: "reset"
            });
        }
    }, [
        serviceName,
        queryId
    ]);
    // realtime hook will make sure we're listening to all of the
    // updates to this service
    (0, _useRealtime.useRealtime)(serviceName, realtime, handleRealtimeEvent);
    (0, _react.useEffect)(function() {
        if (isInitialMount.current) {
            isInitialMount.current = false;
        }
    }, []);
    // derive the loading/reloading state from other substates
    var loading = !skip && !hasCachedData && !state.error;
    var reloading = loading || state.reloading;
    var refetch = (0, _react.useCallback)(function() {
        return dispatch({
            type: "refetch"
        });
    }, [
        dispatch
    ]);
    return (0, _react.useMemo)(function() {
        return _object_spread_props(_object_spread({}, skip ? {
            data: null
        } : cachedData), {
            status: loading ? "loading" : state.error ? "error" : "success",
            refetch: refetch,
            isFetching: reloading,
            error: state.error,
            loading: loading,
            reloading: reloading
        });
    }, // eslint-disable-next-line react-hooks/exhaustive-deps
    [
        skip,
        cachedData.data,
        loading,
        state.error,
        refetch,
        reloading,
        state.error,
        loading,
        reloading
    ]);
}
function reducer(state, action) {
    switch(action.type){
        case "fetching":
            return _object_spread_props(_object_spread({}, state), {
                reloading: true,
                error: null
            });
        case "success":
            return _object_spread_props(_object_spread({}, state), {
                fetched: true,
                fetchedCount: state.fetchedCount + 1,
                reloading: false
            });
        case "error":
            return _object_spread_props(_object_spread({}, state), {
                reloading: false,
                fetched: true,
                fetchedCount: state.fetchedCount + 1,
                error: action.payload
            });
        case "refetch":
            return _object_spread_props(_object_spread({}, state), {
                fetched: false,
                refetchSeq: state.refetchSeq + 1
            });
        case "reset":
            if (state.fetched) {
                return _object_spread_props(_object_spread({}, state), {
                    fetched: false,
                    fetchedCount: 0
                });
            } else {
                return state;
            }
    }
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
