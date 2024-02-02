"use strict";
Object.defineProperty(exports, "__esModule", {
    value: true
});
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    FigbirdContext: function() {
        return FigbirdContext;
    },
    Provider: function() {
        return Provider;
    },
    useFeathers: function() {
        return useFeathers;
    },
    useFigbird: function() {
        return useFigbird;
    }
});
var _react = /*#__PURE__*/ _interop_require_wildcard(require("react"));
var _cache = require("./cache");
function _getRequireWildcardCache(nodeInterop) {
    if (typeof WeakMap !== "function") return null;
    var cacheBabelInterop = new WeakMap();
    var cacheNodeInterop = new WeakMap();
    return (_getRequireWildcardCache = function(nodeInterop) {
        return nodeInterop ? cacheNodeInterop : cacheBabelInterop;
    })(nodeInterop);
}
function _interop_require_wildcard(obj, nodeInterop) {
    if (!nodeInterop && obj && obj.__esModule) {
        return obj;
    }
    if (obj === null || typeof obj !== "object" && typeof obj !== "function") {
        return {
            default: obj
        };
    }
    var cache = _getRequireWildcardCache(nodeInterop);
    if (cache && cache.has(obj)) {
        return cache.get(obj);
    }
    var newObj = {
        __proto__: null
    };
    var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor;
    for(var key in obj){
        if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) {
            var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null;
            if (desc && (desc.get || desc.set)) {
                Object.defineProperty(newObj, key, desc);
            } else {
                newObj[key] = obj[key];
            }
        }
    }
    newObj.default = obj;
    if (cache) {
        cache.set(obj, newObj);
    }
    return newObj;
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
var FigbirdContext = /*#__PURE__*/ (0, _react.createContext)();
var defaultIdField = function(item) {
    return item.id || item._id;
};
var defaultUpdatedAtField = function(item) {
    return item.updatedAt || item.updated_at;
};
var Provider = function(_param) {
    var feathers = _param.feathers, store = _param.store, debug = _param.debug, children = _param.children, props = _object_without_properties(_param, [
        "feathers",
        "store",
        "debug",
        "children"
    ]);
    if (!feathers || !feathers.service) {
        throw new Error("Please pass in a feathers client");
    }
    var idField = useIdField(props.idField);
    var updatedAtField = useUpdatedAtField(props.updatedAtField);
    var config = (0, _react.useMemo)(function() {
        return {
            idField: idField,
            updatedAtField: updatedAtField,
            debug: debug
        };
    }, [
        idField,
        updatedAtField,
        debug
    ]);
    var figbird = (0, _react.useMemo)(function() {
        return {
            feathers: feathers,
            config: config
        };
    }, [
        feathers,
        config
    ]);
    return /*#__PURE__*/ _react.default.createElement(_cache.Provider, {
        store: store
    }, /*#__PURE__*/ _react.default.createElement(FigbirdContext.Provider, {
        value: figbird
    }, children));
};
function useFigbird() {
    return (0, _react.useContext)(FigbirdContext);
}
function useFeathers() {
    var feathers = (0, _react.useContext)(FigbirdContext).feathers;
    return feathers;
}
function useIdField() {
    var idField = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : defaultIdField;
    return (0, _react.useCallback)(function(item) {
        var id = typeof idField === "string" ? item[idField] : idField(item);
        if (!id) console.warn("An item has been received without any ID", item);
        return id;
    }, [
        idField
    ]);
}
function useUpdatedAtField() {
    var updatedAtField = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : defaultUpdatedAtField;
    return (0, _react.useCallback)(function(item) {
        return typeof updatedAtField === "string" ? item[updatedAtField] : updatedAtField(item);
    }, [
        updatedAtField
    ]);
}
