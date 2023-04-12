"use strict";
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "useGet", {
    enumerable: true,
    get: function() {
        return useGet;
    }
});
var _useQuery = require("./useQuery");
var selectData = function(data) {
    return data[0];
};
var transformResponse = function(data) {
    return {
        data: [
            data
        ]
    };
};
function useGet(serviceName, id) {
    var options = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : {};
    return (0, _useQuery.useQuery)(serviceName, options, {
        method: "get",
        id: id,
        selectData: selectData,
        transformResponse: transformResponse
    });
}
