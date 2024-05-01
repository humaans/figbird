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
    FILTERS: function() {
        return FILTERS;
    },
    OPERATORS: function() {
        return OPERATORS;
    },
    filterQuery: function() {
        return filterQuery;
    }
});
function cleanQuery(query, operators, filters) {
    if (Array.isArray(query)) {
        return query.map(function(value) {
            return cleanQuery(value, operators, filters);
        });
    } else if (isObject(query)) {
        var result = {};
        Object.keys(query).forEach(function(key) {
            var value = query[key];
            if (key[0] === '$') {
                if (filters.includes(key)) {
                    return;
                }
                if (!operators.includes(key)) {
                    throw new Error("Invalid query parameter ".concat(key), query);
                }
            }
            result[key] = cleanQuery(value, operators, filters);
        });
        return result;
    }
    return query;
}
var FILTERS = [
    '$sort',
    '$limit',
    '$skip',
    '$select'
];
var OPERATORS = [
    '$in',
    '$nin',
    '$lt',
    '$lte',
    '$gt',
    '$gte',
    '$ne',
    '$or'
];
function filterQuery(query) {
    var options = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : {};
    if (!query) return query;
    var tmp = options.filters, additionalFilters = tmp === void 0 ? [] : tmp, tmp1 = options.operators, additionalOperators = tmp1 === void 0 ? [] : tmp1;
    return cleanQuery(query, OPERATORS.concat(additionalOperators), FILTERS.concat(additionalFilters));
}
function isObject(obj) {
    return typeof obj === 'object' && obj !== null;
}
