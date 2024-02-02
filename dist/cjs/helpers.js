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
    forEachObj: function() {
        return forEachObj;
    },
    getIn: function() {
        return getIn;
    },
    hashObject: function() {
        return hashObject;
    },
    inflight: function() {
        return inflight;
    },
    isObject: function() {
        return isObject;
    },
    matcher: function() {
        return matcher;
    },
    setIn: function() {
        return setIn;
    },
    unsetIn: function() {
        return unsetIn;
    }
});
var _sift = /*#__PURE__*/ _interop_require_default(require("sift"));
var _filterQuery = require("./filterQuery");
function _array_like_to_array(arr, len) {
    if (len == null || len > arr.length) len = arr.length;
    for(var i = 0, arr2 = new Array(len); i < len; i++)arr2[i] = arr[i];
    return arr2;
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
function _interop_require_default(obj) {
    return obj && obj.__esModule ? obj : {
        default: obj
    };
}
function _iterable_to_array(iter) {
    if (typeof Symbol !== "undefined" && iter[Symbol.iterator] != null || iter["@@iterator"] != null) return Array.from(iter);
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
function getIn(obj, path) {
    var _iteratorNormalCompletion = true, _didIteratorError = false, _iteratorError = undefined;
    try {
        for(var _iterator = path[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true){
            var segment = _step.value;
            if (obj) {
                obj = obj[segment];
            }
        }
    } catch (err) {
        _didIteratorError = true;
        _iteratorError = err;
    } finally{
        try {
            if (!_iteratorNormalCompletion && _iterator.return != null) {
                _iterator.return();
            }
        } finally{
            if (_didIteratorError) {
                throw _iteratorError;
            }
        }
    }
    return obj;
}
function setIn(obj, path, value) {
    obj = isObject(obj) ? _object_spread({}, obj) : {};
    var res = obj;
    for(var i = 0; i < path.length; i++){
        var segment = path[i];
        if (i === path.length - 1) {
            obj[segment] = value;
        } else {
            obj[segment] = isObject(obj[segment]) ? _object_spread({}, obj[segment]) : {};
            obj = obj[segment];
        }
    }
    return res;
}
function unsetIn(obj, path) {
    obj = isObject(obj) ? _object_spread({}, obj) : {};
    var res = obj;
    for(var i = 0; i < path.length; i++){
        var segment = path[i];
        if (i === path.length - 1) {
            delete obj[segment];
        } else {
            if (isObject(obj[segment])) {
                obj = obj[segment];
            } else {
                break;
            }
        }
    }
    return res;
}
function isObject(obj) {
    return typeof obj === "object" && obj !== null;
}
function matcher(query, options) {
    var filteredQuery = (0, _filterQuery.filterQuery)(query, options);
    var sifter = (0, _sift.default)(filteredQuery);
    return function(item) {
        return sifter(item);
    };
}
function hashObject(obj) {
    var hash = 0;
    var str = JSON.stringify(obj);
    for(var i = 0; i < str.length; i++){
        var char = str.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash |= 0 // Convert to 32bit integer
        ;
    }
    return numberToBase64(hash);
}
function numberToBase64(num) {
    var buffer = new ArrayBuffer(8);
    var view = new DataView(buffer);
    view.setFloat64(0, num);
    var string = String.fromCharCode.apply(null, new Uint8Array(buffer));
    // Encode the string to base64
    return btoa(string);
}
function forEachObj(obj, fn) {
    for(var key in obj){
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            fn(obj[key], key, obj);
        }
    }
}
function inflight(makeKey, fn) {
    var flying = {};
    return function() {
        for(var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++){
            args[_key] = arguments[_key];
        }
        var key = makeKey.apply(void 0, _to_consumable_array(args));
        if (flying[key]) {
            return flying[key].then(function() {
                return null;
            });
        }
        var res = fn.apply(void 0, _to_consumable_array(args));
        flying[key] = res.then(function(res) {
            delete flying[key];
            return res;
        }).catch(function(err) {
            delete flying[key];
            throw err;
        });
        return flying[key];
    };
}
