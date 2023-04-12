"use strict";
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "useMutation", {
    enumerable: true,
    get: function() {
        return useMutation;
    }
});
var _react = require("react");
var _core = require("./core");
function _array_like_to_array(arr, len) {
    if (len == null || len > arr.length) len = arr.length;
    for(var i = 0, arr2 = new Array(len); i < len; i++)arr2[i] = arr[i];
    return arr2;
}
function _array_with_holes(arr) {
    if (Array.isArray(arr)) return arr;
}
function _array_without_holes(arr) {
    if (Array.isArray(arr)) return _array_like_to_array(arr);
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
function _iterable_to_array(iter) {
    if (typeof Symbol !== "undefined" && iter[Symbol.iterator] != null || iter["@@iterator"] != null) return Array.from(iter);
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
function _non_iterable_spread() {
    throw new TypeError("Invalid attempt to spread non-iterable instance.\\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
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
function _to_consumable_array(arr) {
    return _array_without_holes(arr) || _iterable_to_array(arr) || _unsupported_iterable_to_array(arr) || _non_iterable_spread();
}
function _unsupported_iterable_to_array(o, minLen) {
    if (!o) return;
    if (typeof o === "string") return _array_like_to_array(o, minLen);
    var n = Object.prototype.toString.call(o).slice(8, -1);
    if (n === "Object" && o.constructor) n = o.constructor.name;
    if (n === "Map" || n === "Set") return Array.from(n);
    if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return _array_like_to_array(o, minLen);
}
function useMutation(serviceName) {
    var _useFigbird = (0, _core.useFigbird)(), feathers = _useFigbird.feathers, actions = _useFigbird.actions;
    var _useReducer = _sliced_to_array((0, _react.useReducer)(reducer, {
        status: "idle",
        data: null,
        error: null,
        loading: false
    }), 2), state = _useReducer[0], dispatch = _useReducer[1];
    var mountedRef = (0, _react.useRef)();
    (0, _react.useEffect)(function() {
        mountedRef.current = true;
        return function() {
            mountedRef.current = false;
        };
    }, []);
    var common = [
        serviceName,
        dispatch,
        feathers,
        mountedRef
    ];
    var create = useMethod.apply(void 0, [
        "create",
        actions.feathersCreated
    ].concat(_to_consumable_array(common)));
    var update = useMethod.apply(void 0, [
        "update",
        actions.feathersUpdated
    ].concat(_to_consumable_array(common)));
    var patch = useMethod.apply(void 0, [
        "patch",
        actions.feathersPatched
    ].concat(_to_consumable_array(common)));
    var remove = useMethod.apply(void 0, [
        "remove",
        actions.feathersRemoved
    ].concat(_to_consumable_array(common)));
    var mutation = (0, _react.useMemo)(function() {
        return {
            create: create,
            update: update,
            patch: patch,
            remove: remove,
            data: state.data,
            status: state.status,
            error: state.error,
            loading: state.loading
        };
    }, [
        create,
        update,
        patch,
        remove,
        state
    ]);
    return mutation;
}
function reducer(state, action) {
    switch(action.type){
        case "mutating":
            return _object_spread_props(_object_spread({}, state), {
                status: "loading",
                loading: true,
                data: null,
                error: null
            });
        case "success":
            return _object_spread_props(_object_spread({}, state), {
                status: "success",
                loading: false,
                data: action.payload
            });
        case "error":
            return _object_spread_props(_object_spread({}, state), {
                status: "error",
                loading: false,
                error: action.payload
            });
    }
}
function useMethod(method, action, serviceName, dispatch, feathers, mountedRef) {
    return (0, _react.useCallback)(function() {
        for(var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++){
            args[_key] = arguments[_key];
        }
        var _service;
        var service = feathers.service(serviceName);
        dispatch({
            type: "mutating"
        });
        return (_service = service)[method].apply(_service, _to_consumable_array(args)).then(function(item) {
            var isMounted = mountedRef.current;
            action({
                serviceName: serviceName,
                item: item
            });
            isMounted && dispatch({
                type: "success",
                payload: item
            });
            return item;
        }).catch(function(err) {
            var isMounted = mountedRef.current;
            isMounted && dispatch({
                type: "error",
                payload: err
            });
            throw err;
        });
    }, [
        serviceName,
        method,
        action,
        dispatch
    ]);
}
