'use strict';
var _ = require('underscore');


function assert(cond, message) {
    if (!cond) {
        throw new Error(message);
    }
};


function heir(object) {
    function Heir() {};
    Heir.prototype = object;
    return new Heir();
};


function makePrototype(Constructor, SuperConstructor, mixin) {
    Constructor.prototype = heir(SuperConstructor.prototype);
    Constructor.prototype.constructor = Constructor;
    if (mixin) {
        _.extend(Constructor.prototype, mixin);
    }
    return Constructor;
};


function Set() {
    this.clear();
};
_.extend(Set.prototype, {
    'length': 0,

    'add': function(value) {
        var added = false;
        var key = this.makeKey(value);
        if (!this.members.hasOwnProperty(key)) {
            this.length++;
            added = true;
        }
        this.members[key] = value;
        return added;
    },

    'remove': function(value) {
        var removed = false;
        var key = this.makeKey(value);
        if (this.members.hasOwnProperty(key)) {
            this.length--;
            removed = true;
        }
        delete this.members[key];
        return removed;
    },

    'has': function(value) {
        var key = this.makeKey(value);
        return this.members.hasOwnProperty(key);
    },

    'isEmpty': function() {
        return this.length === 0;
    },

    'clear': function() {
        this.members = {};
        delete this.length;
        return this;
    },

    'toArray': function() {
        return _.values(this.members);
    },

    '_': function(fname) {
        var args = _.toArray(arguments);
        args[0] = this.members;
        return _[fname].apply(_, args);
    }
});


// Create a dictionary-like object that has a default value for any missing
// key. Specify this default with a function that returns an instance or a
// native type.
function DefaultDict(newValue) {
    this.newValue = _.isFunction(newValue) ? newValue : function() {
        return newValue;
    };
    this.properties = {};
};
_.extend(DefaultDict.prototype, {
    // Get a property. Set a default value if necessary.
    'get': function(property) {
        return (this.has(property) ?
                this.properties[property] :
                (this.properties[property] = this.newValue(property)));
    },

    // Set a value.
    'set': function(property, value) {
        this.properties[property] = value;
        return value;
    },

    // Remove a property.
    'remove': function(property) {
        var value = this.properties[property];
        delete this.properties[property];
        return value;
    },

    'clear': function() {
        this.properties = {};
        return this;
    },

    // Return `true` iff the dictionary already has a property.
    // This function should be used carefully since it does not avoid
    // default values.
    'has': function(property) {
        return this.properties.hasOwnProperty(property);
    },

    // Return a clone of the current state of the properties dictionary.
    'toObject': function() {
        return _.clone(this.properties);
    },

    '_': function() {
        if (arguments.length === 0) {
            return _(this.properties);
        } else {
            var args = _.toArray(arguments);
            var fname = args[0];
            args[0] = this.properties;
            return _[fname].apply(_, args);
        }
    }
});


exports.assert = assert;
exports.heir = heir;
exports.makePrototype = makePrototype;
exports.DefaultDict = DefaultDict;
exports.Set = Set;
