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
var _reactdom = require("react-dom");
var _core = require("./core");
var _useRealtime = require("./useRealtime");
var _cache = require("./cache");
var _fetch = require("./fetch");
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
var fetchPolicies = [
    'swr',
    'cache-first',
    'network-only'
];
var realtimeModes = [
    'merge',
    'refetch',
    'disabled'
];
function reducer(state, action) {
    switch(action.type){
        case 'success':
            return _object_spread_props(_object_spread({}, state), {
                status: 'success',
                dirty: false
            });
        case 'error':
            return _object_spread_props(_object_spread({}, state), {
                status: 'error',
                error: action.error,
                dirty: false
            });
        case 'reset':
            var _action_dirty;
            return _object_spread_props(_object_spread({}, state), {
                status: 'pending',
                error: null,
                dirty: (_action_dirty = action.dirty) !== null && _action_dirty !== void 0 ? _action_dirty : state.dirty || state.status === 'pending'
            });
    }
}
function useQuery(serviceName) {
    var options = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : {}, queryHookOptions = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : {};
    var _useFigbird = (0, _core.useFigbird)(), config = _useFigbird.config, feathers = _useFigbird.feathers;
    var skip = options.skip, allPages = options.allPages, parallel = options.parallel, parallelLimit = options.parallelLimit, _options_realtime = options.realtime, realtime = _options_realtime === void 0 ? 'merge' : _options_realtime, _options_fetchPolicy = options.fetchPolicy, fetchPolicy = _options_fetchPolicy === void 0 ? 'swr' : _options_fetchPolicy, matcher = options.matcher, params = _object_without_properties(options, [
        "skip",
        "allPages",
        "parallel",
        "parallelLimit",
        "realtime",
        "fetchPolicy",
        "matcher"
    ]);
    var method = queryHookOptions.method, id = queryHookOptions.id, selectData = queryHookOptions.selectData, transformResponse = queryHookOptions.transformResponse;
    if (!realtimeModes.includes(realtime)) {
        throw new Error("Bad realtime option, must be one of ".concat([
            realtimeModes
        ].join(', ')));
    }
    if (!fetchPolicies.includes(fetchPolicy)) {
        throw new Error("Bad fetchPolicy option, must be one of ".concat([
            fetchPolicies
        ].join(', ')));
    }
    if (config.defaultPageSizeWhenFetchingAll && allPages && (!params.query || !params.query.$limit)) {
        params = _object_spread({}, params);
        params.query = _object_spread({}, params.query);
        params.query.$limit = config.defaultPageSizeWhenFetchingAll;
    } else if (config.defaultPageSize && (!params.query || !params.query.$limit)) {
        params = _object_spread({}, params);
        params.query = _object_spread({}, params.query);
        params.query.$limit = config.defaultPageSize;
    }
    var queryId = useQueryHash({
        serviceName: serviceName,
        method: method,
        id: id,
        params: params,
        allPages: allPages,
        realtime: realtime
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    params = (0, _react.useMemo)(function() {
        return params;
    }, [
        queryId
    ]);
    var _useCache = _sliced_to_array((0, _cache.useCache)({
        queryId: queryId,
        serviceName: serviceName,
        method: method,
        params: params,
        realtime: realtime,
        selectData: selectData,
        matcher: matcher
    }), 2), cachedResult = _useCache[0], updateCache = _useCache[1];
    var isCacheSufficient = fetchPolicy === 'cache-first' && !!cachedResult;
    var _useReducer = _sliced_to_array((0, _react.useReducer)(reducer, {
        status: isCacheSufficient ? 'success' : 'pending',
        dirty: false,
        error: null
    }), 2), state = _useReducer[0], dispatch = _useReducer[1];
    var isPending = state.status === 'pending';
    var initialisedRef = (0, _react.useRef)(false);
    var requestRef = (0, _react.useRef)(0);
    (0, _react.useEffect)(function() {
        if (skip) return;
        if (!isPending) return;
        if (isCacheSufficient) return;
        // increment the request ref so we can ignore old requests
        var reqRef = requestRef.current = requestRef.current + 1;
        (0, _fetch.fetch)(feathers, serviceName, method, id, params, {
            queryId: queryId,
            allPages: allPages,
            parallel: parallel,
            parallelLimit: parallelLimit,
            transformResponse: transformResponse
        }).then(function(res) {
            if (state.dirty) {
                dispatch({
                    type: 'reset',
                    dirty: false
                });
            } else if (reqRef === requestRef.current) {
                (0, _reactdom.flushSync)(function() {
                    updateCache(res);
                    dispatch({
                        type: 'success'
                    });
                });
            }
        }).catch(function(error) {
            if (state.dirty) {
                dispatch({
                    type: 'reset',
                    dirty: false
                });
            }
            if (reqRef === requestRef.current) {
                dispatch({
                    type: 'error',
                    error: error
                });
            }
        }).finally(function() {
            initialisedRef.current = true;
        });
    }, [
        feathers,
        queryId,
        serviceName,
        method,
        id,
        params,
        transformResponse,
        skip,
        allPages,
        parallel,
        parallelLimit,
        updateCache,
        isPending,
        isCacheSufficient,
        state.dirty
    ]);
    var refetch = (0, _react.useCallback)(function() {
        return dispatch({
            type: 'reset'
        });
    }, [
        dispatch
    ]);
    // refetch if the query changes
    (0, _react.useEffect)(function() {
        if (!isCacheSufficient && initialisedRef.current) {
            refetch();
        }
    }, [
        refetch,
        queryId,
        isCacheSufficient
    ]);
    // realtime hook subscribes to realtime updates to this service
    (0, _useRealtime.useRealtime)(serviceName, realtime, refetch);
    var status;
    var isFetching;
    var result = (0, _react.useMemo)(function() {
        return {
            data: null
        };
    }, []);
    var error = state.error;
    if (skip) {
        status = 'success';
        isFetching = false;
    } else if (state.status === 'error') {
        status = 'error';
        isFetching = false;
    } else if (fetchPolicy === 'swr') {
        status = cachedResult ? 'success' : 'loading';
        isFetching = isPending || status === 'loading';
        result = cachedResult || result;
    } else if (fetchPolicy === 'cache-first') {
        status = cachedResult ? 'success' : 'loading';
        isFetching = isPending || status === 'loading';
        result = cachedResult || result;
    } else if (fetchPolicy === 'network-only') {
        status = isPending || !cachedResult ? 'loading' : 'success';
        isFetching = isPending || status === 'loading';
        result = isFetching ? result : cachedResult;
    }
    return (0, _react.useMemo)(function() {
        return _object_spread_props(_object_spread({}, result), {
            status: status,
            refetch: refetch,
            isFetching: isFetching,
            error: error
        });
    }, [
        result,
        status,
        error,
        refetch,
        isFetching
    ]);
}
function useQueryHash(param) {
    var serviceName = param.serviceName, method = param.method, id = param.id, params = param.params, allPages = param.allPages, realtime = param.realtime;
    return (0, _react.useMemo)(function() {
        var hash = (0, _helpers.hashObject)({
            serviceName: serviceName,
            method: method,
            id: id,
            params: params,
            allPages: allPages,
            realtime: realtime
        });
        return "".concat(method, ":").concat(hash);
    }, [
        serviceName,
        method,
        id,
        params,
        allPages,
        realtime
    ]);
}
