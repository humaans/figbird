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
    useGet: function() {
        return _figbird.useGet;
    },
    useFind: function() {
        return _figbird.useFind;
    },
    useMutation: function() {
        return _figbird.useMutation;
    },
    Provider: function() {
        return _figbird.Provider;
    },
    useFigbird: function() {
        return _figbird.useFigbird;
    },
    useFeathers: function() {
        return _figbird.useFeathers;
    },
    namespace: function() {
        return _figbird.namespace;
    }
});
var _figbird = require("./figbird");
