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
    Provider: function() {
        return _figbird.Provider;
    },
    cache: function() {
        return _figbird.cache;
    },
    createStore: function() {
        return _figbird.createStore;
    },
    useFeathers: function() {
        return _figbird.useFeathers;
    },
    useFigbird: function() {
        return _figbird.useFigbird;
    },
    useFind: function() {
        return _figbird.useFind;
    },
    useGet: function() {
        return _figbird.useGet;
    },
    useMutation: function() {
        return _figbird.useMutation;
    }
});
var _figbird = require("./figbird");
