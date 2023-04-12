"use strict";
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "useFind", {
    enumerable: true,
    get: function() {
        return useFind;
    }
});
var _useQuery = require("./useQuery");
var selectData = function(data) {
    return data;
};
var transformResponse = function(data) {
    return data;
};
function useFind(serviceName) {
    var options = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : {};
    return (0, _useQuery.useQuery)(serviceName, options, {
        method: "find",
        selectData: selectData,
        transformResponse: transformResponse
    });
}
