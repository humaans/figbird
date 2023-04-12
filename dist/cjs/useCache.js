"use strict";
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "useCache", {
    enumerable: true,
    get: function() {
        return useCache;
    }
});
var _react = require("react");
var _core = require("./core");
var _namespace = require("./namespace");
var _helpers = require("./helpers");
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
function useCache(resourceDescriptor) {
    var serviceName = resourceDescriptor.serviceName, queryId = resourceDescriptor.queryId, method = resourceDescriptor.method, id = resourceDescriptor.id, params = resourceDescriptor.params, realtime = resourceDescriptor.realtime, selectData = resourceDescriptor.selectData, transformResponse = resourceDescriptor.transformResponse, matcher = resourceDescriptor.matcher;
    var _useFigbird = (0, _core.useFigbird)(), actions = _useFigbird.actions, useSelector = _useFigbird.useSelector;
    // we'll use a cheeky ref to store the previous mapped data array
    // because if the underlying list of data didn't change we don't
    // want consumers of useFind to have to worry about changing reference
    var dataRef = (0, _react.useRef)([]);
    var cachedData = useSelector(function(state) {
        var query = (0, _helpers.getIn)(state, [
            _namespace.namespace,
            "queries",
            serviceName,
            queryId
        ]);
        if (query) {
            var data = query.data, meta = query.meta;
            var entities = query.entities || (0, _helpers.getIn)(state, [
                _namespace.namespace,
                "entities",
                serviceName
            ]);
            data = data.map(function(id) {
                return entities[id];
            });
            if (same(data, dataRef.current)) {
                data = dataRef.current;
            } else {
                dataRef.current = data;
            }
            data = selectData(data);
            return _object_spread_props(_object_spread({}, meta), {
                data: data
            });
        } else {
            return {
                data: null
            };
        }
    }, {
        deps: [
            serviceName,
            queryId,
            selectData
        ]
    });
    var onFetched = function(data) {
        return actions.feathersFetched({
            serviceName: serviceName,
            queryId: queryId,
            method: method,
            params: params,
            data: _object_spread({}, transformResponse(data), id ? {
                id: id
            } : {}),
            realtime: realtime,
            matcher: matcher
        });
    };
    return [
        cachedData,
        onFetched
    ];
}
function same(a, b) {
    if (a.length !== b.length) return false;
    for(var i = 0; i < a.length; i++){
        if (a[i] !== b[i]) return false;
    }
    return true;
}
