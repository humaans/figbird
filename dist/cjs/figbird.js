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
        return _core.Provider;
    },
    cache: function() {
        return _cache.cache;
    },
    createStore: function() {
        return _kinfolk.createStore;
    },
    useFeathers: function() {
        return _core.useFeathers;
    },
    useFigbird: function() {
        return _core.useFigbird;
    },
    useFind: function() {
        return _useFind.useFind;
    },
    useGet: function() {
        return _useGet.useGet;
    },
    useMutation: function() {
        return _useMutation.useMutation;
    }
});
var _kinfolk = require("kinfolk");
var _cache = require("./cache");
var _useGet = require("./useGet");
var _useFind = require("./useFind");
var _useMutation = require("./useMutation");
var _core = require("./core");
