"use strict";
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "usePrevious", {
    enumerable: true,
    get: function() {
        return usePrevious;
    }
});
var _react = require("react");
function usePrevious(value) {
    var ref = (0, _react.useRef)(undefined);
    var prev = ref.current;
    ref.current = value;
    return prev;
}
