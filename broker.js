'use strict';
var _ = require('underscore');
var util = require('./util.js');


// Create an object that brokers named values and mediates calculations for values that depend on
// other names.
function Broker() {
    this.changeQueue = [];
    this.properties = new util.DefaultDict(function(key) {
        return new Property(this.broker, key);
    });
    this.properties.broker = this;
    this.processingLoop = new ProcessingLoop(this);
    this.values = {};
    this.oldValues = {};
};
_.extend(Broker.prototype, {
    'debug': false,

    'processing': false,

    'destroyProps': [
        'changeQueue',
        'processing',
        'processingLoop',
        'properties',
        'values',
        'oldValues'],

    // Destroy the instance and all dependent requests and calculations.
    'destroy': function() {
        if (this.properties) {
            this.properties._('invoke', 'destroy');
            _.each(this.destroyProps, function(prop) {
                delete this[prop];
            }, this);
        }
        return this;
    },

    // Request a value. Receive updates when the value changes or is
    // removed. Return a `Request` that acts as a `cancel()`able
    // handle.
    //
    //     broker.request({
    //         'name': 'some:prop',
    //         'value': function(value, oldValue) { /*...*/ },
    //         'arbitrary': [1, 2, 3]
    //     });
    'request': function(kwargs) {
        if (typeof kwargs === 'string') {
            return this.request({'name': kwargs});
        } else {
            var Req = kwargs.name ? SimpleRequest : Request;
            return new Req(this, kwargs);
        }
    },

    // Create a `Calculation` associating a target and sources in the
    // broker.
    //
    //     broker.calculate({
    //         'target': 'xyzzy',
    //         'sources': ['foo', 'bar', 'baz'],
    //         'calculate': function(sources) {
    //             return sources['foo'] + sources['bar'] + sources['baz'] + this.a;
    //         },
    //         'a': 1
    //     });
    'calculate': function(opts) {
        return new Calculation(this, opts);
    },

    // synchronous accessors

    // Get a named value. Return `undefined` if the name is not set.
    'get': function(name) {
        return this.properties.has(name) ? this.properties.get(name).value : undefined;
    },

    'has': function(name) {
        return this.get(name) !== undefined;
    },

    // Get all names from the broker as an object.
    'getAll': function(names) {
        var all = {};
        _.each(names, function(name) {
            all[name] = this.get(name);
        }, this);
        return all;
    },

    // broker actions

    'modify': function(name, func, context) {
        this
            .enqueue({
                'name': name,
                'action': 'modify',
                'args': [func, context]
            })
            .process();
        return this;
    },

    // Set a value in the broker. The value is only set if it is missing
    // or not `_.isEqual()` from the current value.
    'set': function(name, value) {
        this
            .enqueue({
                'name': name,
                'action': 'set',
                'args': [value]
            })
            .process();
        return this;
    },

    'remove': function(name) {
        return this.set(name, undefined);
    },

    'setAll': function(kwargs) {
        _.each(kwargs, function(value, name) {
            this.enqueue({
                'name': name,
                'action': 'set',
                'args': [value]
            });
        }, this);
        this.process();
        return this;
    },

    'enqueue': function(command) {
        this.changeQueue.push(command);
        return this;
    },

    // debugging

    'debugName': function(name) {
        return this.debug || this.properties.get(name).debug;
    },

    'setDebugNames': function() {
        _.each(arguments, function(name) {
            this.properties.get(name).debug = true;
        }, this);
        return this;
    },

    // processing loop

    'process': function() {
        if (!this.processing) {
            this.processing = true;
            // Track changed values. Clear the set only after completely leaving the processing
            // loop. This ensures that subsequent triggered calculations can consider changes
            // part of the same graph of affected properties.
            this.valueChanged = {};

            while (this.changeQueue.length > 0) {
                this.processingLoop
                    .takeChanges()
                    .lockNodes()
                    .modifyNodes()
                    .unlockAll();
            } // end change queue processing loop

            delete this.valueChanged;
            this.processing = false;
        }
        return this;
    },

    'changed': function(name) {
        return !!(this.valueChanged && this.valueChanged[name]);
    }
});

function ConstantCalculation(target, value) {
    this.target = target;
    this.value = value;
};
ConstantCalculation.prototype.calculate = function() {
    return this.value;
};

function AliasCalculation(to, from) {
    this.target = to;
    this.sources = [from];
};
AliasCalculation.prototype.calculate = function(sources) {
    return sources[this.sources[0]];
};

// A Broker with useful shorthand functions.
function DataBroker() {
    Broker.apply(this, arguments);
};
util.makePrototype(DataBroker, Broker, {
    // Alias a name to another name using a simple calculation.
    //
    //    broker.calculate({'from': 'source', 'to': 'target'});
    //
    'alias': function(kwargs) {
        return this.calculate(new AliasCalculation(kwargs.to, kwargs.from));
    },

    'constant': function(kwargs) {
        return this.calculate(new ConstantCalculation(kwargs.target, kwargs.value));
    },

    // debugging

    'analyze': function(name, cache) {
        cache || (cache = {});
        var info = cache[name];
        if (!info) {
            cache[name] = info = {
                'name': name,
                'value': this.get(name),
                'requests': this.requests.get(name).length
            };
            var calc = this.calculations[name];
            if (calc && calc.sources.length > 0) {
                info.sources = {};
                _.each(calc.sources, function(name) {
                    info.sources[name] = this.analyze(name, cache);
                }, this);
            }
        }
        return info;
    },

    'getDependencies': function(name) {
        var values = {};
        var calcs = [];
        function nextCalc(name) {
            if (!(name in values)) {
                var property = this.properties.get(name);
                values[name] = property.value;
                if (property.calculation) {
                    calcs.push(property.calculation);
                }
            }
        };
        nextCalc.call(this, name);
        while (calcs.length > 0) {
            _.each(calcs.pop().sources, nextCalc, this);
        }
        return values;
    },

    'logDependencies': function(name) {
        _.each(this.getDependencies(name), function(value, name) {
            console.log(name, '=>', value);
        }, this);
    }
});


// Encapsulate the broker change processing loop.
function ProcessingLoop(broker) {
    this.broker = broker;
    util.assert(this.broker, 'broker is missing');
    this.locked = new NodeSet();
    this.sourcesLocked = new NodeSet();
};
_.extend(ProcessingLoop.prototype, {
    'debug': false,

    'safe': true,

    // Sort changes. First, modify edges. Then, set values.
    'actionToKey': {
        'removeCalculation': 0,
        'setCalculation': 1,
        'addRequest': 2,
        'removeRequest': 3,
        'set': 4,
        'modify': 6},

    'makeChangeSortKey': function(change) {
        return this.actionToKey[change.action];
    },

    // action phases of the processing loop

    'takeChanges': function() {
        util.assert(!this.changes, 'changes already present');
        this.changes = _.sortBy(this.broker.changeQueue, this.makeChangeSortKey, this);
        this.broker.changeQueue.length = 0;
        return this;
    },

    // Lock affected parts of the graph.
    'lockNodes': function() {
        util.assert(this.changes, 'changes missing');

        _.each(this.changes, function(change) {
            var property = this.broker.properties.get(change.name);
            this[change.action](property, change);
            // See 'broker actions' below.
        }, this);
        this.debug && this.debugLocked('locked');

        return this;
    },

    // Modify the graph and dispatch values.
    'modifyNodes': function() {
        util.assert(this.changes, 'changes missing');

        _.each(this.changes, function(change) {
            var property = this.broker.properties.get(change.name);
            property[change.action].apply(property, change.args);
        }, this);

        return this;
    },

    // Unlock self-locked nodes. This triggers calculations and observers.
    'unlockAll': function() {
        this.locked._('each', this.safe ? this.safeUnlockSelf : this.unlockSelf, this);
        this.debug && this.debugLocked('unlocked');
        this.locked.clear();
        this.sourcesLocked.clear();
        delete this.changes;

        return this;
    },

    // utility

    'debugLocked': function(label) {
        console.group(label);
        this.locked._('each', function(node) {
            console.log('%o(%o)', node, node.name || node.names);
        }, this);
        console.groupEnd(label);
        return this;
    },

    'lockSelf': function(node) {
        node.lockSelf();
        this.locked.add(node);

        return this;
    },

    'unlockSelf': function(node) {
        node.unlockSelf();
    },

    'safeUnlockSelf': function(node) {
        try {
            this.unlockSelf(node);
        } catch (ex) {
            console.error(ex.stack);
        }
    },

    // Breadth-first walk and self-lock the node's sources.
    'lockSources': function(node) {
        // Keep track of recursion for property cycles.
        if (!this.sourcesLocked.has(node)) {
            this.lockSelf(node);
            this.sourcesLocked.add(node);
            node.sources._('each', this.lockSources, this);
        }

        return this;
    },

    // broker actions

    'removeCalculation': function(property) {
        this.lockSources(property);

        return this;
    },

    'setCalculation': function(property, change) {
        var calculation = change.args[0];

        this.lockSources(property);
        _.each(calculation.sources, function(name) {
            var source = this.broker.properties.get(name);
            this.lockSources(source);
        }, this);

        return this;
    },

    'addRequest': function(property, change) {
        var request = change.args[0];

        this.lockSources(request);
        this.lockSources(property);

        return this;
    },

    'removeRequest': function(property, change) {
        var request = change.args[0];

        this.lockSources(request);

        return this;
    },

    'set': function(property) {
        property.sinks._('each', this.lockSelf, this);

        return this;
    },

    'modify': function() {
        return this.set.apply(this, arguments);
    }
});


// A base prototype for `Request`s and `Property`s. Encapsulate locking and state transition
// behavior. Provide sets for source, sink, and locks.
function BrokerNode(broker) {
    this.broker = broker;

    util.assert(this.broker, 'broker is missing');

    this.id = _.uniqueId('BrokerNode.');
    // `sources` are upstream nodes
    this.sources = new NodeSet();
    // `sinks` are downstream nodes.
    this.sinks = new NodeSet();
    // `locks` is a semaphore controlling state transition for the instance.
    this.locks = new NodeSet();
};
_.extend(BrokerNode.prototype, {
    'debug': false,

    'initialized': false,

    'destroyProps': ['sinks', 'sources', 'locks'],

    'destroy': function() {
        if (this.broker) {
            _.each(this.destroyProps, function(key) {
                this[key].clear();
                delete this[key];
            }, this);
            delete this.broker;
        }
        return this;
    },

    // Save the state of the node for consideration after all changes are applied.
    'saveState': function() {
        util.assert(!this.state, 'state already saved');

        this.state = this.getState();
        this.lockSinks();
        return this;
    },

    // Determine any actions that need to occur due to state changes in the node.
    'considerState': function() {
        util.assert(this.state, 'state not saved');

        if (!this.initialized) {
            this.initialized = true;
        }

        var oldState = this.state;
        delete this.state;
        var newState = this.getState();
        this.transitionState(oldState, newState);
        return this;
    },

    // Get the state of the node. Subprototypes should implement this.
    'getState': function() {},

    // Transition the node between states. Subprototypes should implement this.
    'transitionState': function(oldState, newState) {},

    // accessors

    'isLocked': function() {
        return this.locks.length > 0;
    },

    // modifiers

    'addLock': function(property) {
        return this.changeLock(function() {
            this.locks.add(property);
        });
    },

    'removeLock': function(property) {
        return this.changeLock(function() {
            this.locks.remove(property);
        });
    },

    // Nodes are only self-locked during the processing loop.

    'lockSelf': function() {
        return this.addLock(this);
    },

    'unlockSelf': function() {
        return this.removeLock(this);
    },

    // Sinks are locked whenever `this` becomes locked.

    'lockSinks': function() {
        this.sinks._('each', function(sink) {
            sink.addLock(this);
        }, this);
        return this;
    },

    // Sinks are unlocked when `this` explicitly unlocks them, usually after its state is
    // resolved.

    'unlockSinks': function() {
        this.sinks._('each', function(sink) {
            sink.removeLock(this);
        }, this);
        return this;
    },

    // utility

    // Modify the lock set. Return `true` iff the locking state changed.
    'changeLock': function(func) {
        var wasLocked = this.isLocked();
        func.call(this);
        var isLocked = this.isLocked();

        if (wasLocked !== isLocked) {
            this[isLocked ? 'saveState' : 'considerState']();
            return true;
        } else {
            return false;
        }
    },

    // manage edges

    // Add a sink. Locks follow the sink edge.
    'addSink': function(sink) {
        this.sinks.add(sink);
        if (this.isLocked()) {
            sink.addLock(this);
        }
        return this;
    },

    // Remove a sink. Locks follow the sink edge.
    'removeSink': function(sink) {
        this.sinks.remove(sink);
        if (this.isLocked()) {
            sink.removeLock(this);
        }
        return this;
    }
});


// Associate a callback function and context with a broker that triggers
// when the value changes.
function Request(broker, kwargs) {
    _.extend(this, kwargs);
    BrokerNode.call(this, broker);

    util.assert(this.broker, 'broker is missing');
    util.assert(
        (_.isArray(this.names) &&
         (this.names.length > 0) &&
         _.all(this.names, _.isString)),
        'names is not an array of strings: ' + this.names);
    util.assert(_.isFunction(this.value), 'value is not a function: ' + this.value);

    _.each(this.names, function(name) {
        this.broker.enqueue({
            'name': name,
            'action': 'addRequest',
            'args': [this]
        });
    }, this);
    this.broker.process();
};
util.makePrototype(Request, BrokerNode, {
    'canceled': false,

    // Cancel value notifications.
    'cancel': function() {
        if (!this.canceled) {
            this.canceled = true;

            // Remove the request from the broker.
            _.each(this.names, function(name) {
                this.broker.enqueue({
                    'name': name,
                    'action': 'removeRequest',
                    'args': [this]
                });
            }, this);
            this.broker.process();
        }
        return this;
    },

    // BrokerNode

    'getState': function() {
        return {
            'initialized': this.initialized,
            'values': this.broker.getAll(this.names)
        };
    },

    'transitionState': function(oldState, newState) {
        function isSatisfied(name) {
            return newState.values[name] !== undefined;
        };
        function isChanged(name) {
            return oldState.values[name] !== newState.values[name];
        };
        if (_.all(this.names, isSatisfied) &&
            ((!oldState.initialized && newState.initialized) ||
             _.any(this.names, isChanged))) {
            this.notify();
        }
        return this;
    },

    'notify': function() {
        this.value(this.broker.values, this.broker.oldValues);
        return this;
    },

    // Callback for when the value of property changes.
    // This should be overridden in instances.
    'value': function(values, oldValues) {}
});

function SimpleRequest(broker, kwargs) {
    util.assert(kwargs.name, 'name missing');
    kwargs.names = [kwargs.name];
    Request.call(this, broker, kwargs);
};
util.makePrototype(SimpleRequest, Request, {
    'notify': function() {
        this.value(this.broker.values[this.name], this.broker.oldValues[this.name]);
        return this;
    },

    // Callback for when the value of property changes.
    'value': function(currentValue, oldValue) {}
});


// Encapsulate context alongside a function for calculating a dependent
// broker property from other broker properties.
function Calculation(broker, kwargs) {
    _.extend(this, kwargs);
    this.broker = broker;

    util.assert(this.broker);
    util.assert(_.isString(this.target), 'target is not a string: ' + this.target);
    util.assert(_.isArray(this.sources) && _.all(this.sources, _.isString), 'sources is not an array of strings: ' + this.sources);
    util.assert(_.isFunction(this.calculate), 'calculate is not a function: ' + this.calculate);
    util.assert(_.isFunction(this.uncalculate), 'uncalculate is not a function: ' + this.uncalculate);

    if (this.debug) {
        this.broker.setDebugNames(this.target);
    }

    this.broker
        .enqueue({
            'name': this.target,
            'action': 'setCalculation',
            'args': [this]
        })
        .process();
};
_.extend(Calculation.prototype, {
    'canceled': false,

    'debug': false,

    'defaultValue': undefined,

    // Default to calculations with no sources.
    // These are triggered when they are requested.
    'sources': [],

    // Cancel a calculation. Remove it from the broker and uncalculate if
    // necessary.
    'cancel': function() {
        if (!this.canceled) {
            this.canceled = true;

            this.broker
                .enqueue({
                    'name': this.target,
                    'action': 'removeCalculation',
                    'args': [this]
                })
                .process();
        }
        return this;
    },

    // Callback for calculating a target from sources.
    // This should be overridden in instances.
    'calculate': function(sources, oldValue) {},

    // Callback for uncalculating a target.
    // This can be overridden in instances.
    'uncalculate': function(oldValue) {},

    'getSources': function() {
        return this.broker.getAll(this.sources);
    },

    // Gather sources and call `calculate()`.
    'performCalculate': function() {
        this.broker.debugName(this.target) && console.log('%o(target=%o, sources=%o) calculate', this, this.target, this.getSources());
        var oldValue = this.get();
        var value = this.calculate(this.broker.values, oldValue);
        this.set(value);
        return this;
    },

    'performUncalculate': function() {
        var oldValue = this.get();
        this.broker.debugName(this.target) && console.log('%o(target=%o) uncalculate', this, this.target);

        this.profile && console.profile(this.target + ' uncalc');
        this.uncalculate(oldValue);
        this.profile && console.profileEnd(this.target + ' uncalc');

        this.set(this.defaultValue);
        return this;
    },

    // proxies for the target in the broker

    'get': function() {
        return this.broker.get(this.target);
    },

    'has': function() {
        return this.broker.has(this.target);
    },

    'set': function(value) {
        this.broker.set(this.target, value);
        return this;
    },

    'remove': function() {
        this.broker.remove(this.target);
        return this;
    },

    'modify': function(func) {
        this.broker.modify(this.target, func, this);
        return this;
    }
});


// A property is a node representing a name and value.
function Property(broker, name) {
    util.assert(name && _.isString(name), 'name is missing');

    BrokerNode.call(this, broker);
    this.name = name;

    // Requests are sinks that represent a requirement for the data this node provides.
    this.requests = new NodeSet();
    // Weak requests are sinks for which some sink is (weakly or strongly) requested.
    this.weakRequests = new NodeSet();
};
util.makePrototype(Property, BrokerNode, {
    'calculation': null,

    'value': undefined,

    'destroy': function() {
        _.each(['requests', 'weakRequests'], function(key) {
            this[key].clear();
            delete this[key];
        }, this);
        return BrokerNode.prototype.destroy.call(this);
    },

    'hasValue': function() {
        return this.value !== undefined;
    },

    'hasSources': function() {
        return this.sources._('all', function(node) {
            return node.hasValue();
        }, this);
    },

    'isRequested': function() {
        return ((this.requests.length > 0) ||
                (this.weakRequests.length > 0));
    },

    'canCalculate': function() {
        return !!this.calculation && this.isRequested() && this.hasSources();
    },

    'sourceValues': function() {
        var values = {};
        this.sources._('each', function(property) {
            values[property.name] = property.value;
        }, this);
        return values;
    },

    // utility

    'debugName': function() {
        return this.broker.debugName(this.name);
    },

    // Consider changes to `isRequested()` when adding or removing requests. This function is
    // used internally to implement recursive (weak) requesting of the source graph for a
    // `Property`. Requests recursively follow the source relation as weak requests.
    'changeRequested': function(func) {
        var wasRequested = this.isRequested();
        func.call(this);
        var isRequested = this.isRequested();

        if (wasRequested !== isRequested) {
            this.sources._('each', function(source) {
                source.addWeakRequest(this);
            }, this);
        }
        return this;
    },

    'addWeakRequest': function(property) {
        return this.changeRequested(function() {
            this.weakRequests.add(property);
        });
    },

    'removeWeakRequest': function(property) {
        return this.changeRequested(function() {
            this.weakRequests.remove(property);
        });
    },

    // state transitions

    'getState': function() {
        return {
            'calculation': this.calculation,
            'canCalculate': this.canCalculate(),
            'sourceValues': this.sourceValues()
        };
    },

    'transitionState': function(oldState, newState) {
        function sameValue(value, name) {
            return value === oldState.sourceValues[name];
        };
        // Perform any calculation tasks.
        var shouldUnlock = true;
        if (newState.calculation) {
            if ((oldState.canCalculate !== newState.canCalculate) ||
                (oldState.calculation !== newState.calculation)) {
                this.calculation[newState.canCalculate ? 'performCalculate' : 'performUncalculate']();
                shouldUnlock = false;
            } else if (newState.canCalculate && !_.all(newState.sourceValues, sameValue)) {
                // Trigger a calculation after source values change.
                this.calculation.performCalculate();
                shouldUnlock = false;
            }
        }
        if (shouldUnlock) {
            this.unlockSinks();
        }

        return this;
    },

    // broker changes

    // Add a source. Requests (weakly) follow the source edge.
    'addSource': function(source) {
        this.sources.add(source);
        if (this.isRequested()) {
            source.addWeakRequest(this);
        }
        return this;
    },

    // Remove a source. Requests (weakly) follow the source edge.
    'removeSource': function(source) {
        this.sources.remove(source);
        if (this.isRequested()) {
            source.removeWeakRequest(this);
        }
        return this;
    },

    'addRequest': function(request) {
        return this.changeRequested(function() {
            this.debugName() && console.log('%o(%o) add request %o', this, this.name, request);
            request.sources.add(this);
            this.requests.add(request);
            this.addSink(request);
        });
    },

    'removeRequest': function(request) {
        return this.changeRequested(function() {
            this.debugName() && console.log('%o(%o) remove request %o', this, this.name, request);
            this.requests.remove(request);
            this.removeSink(request);
        });
    },

    'set': function(value) {
        if (!_.isEqual(this.value, value)) {
            // TODO check for double set
            // Provide values in the interface for calculations and requests.
            var oldValue = this.broker.oldValues[this.name] = this.value;
            this.broker.values[this.name] = this.value = value;
            this.broker.valueChanged[this.name] = true;
            this.debugName() && console.log('%o(%o) %o => %o', this, this.name, oldValue, value);
        }

        this.unlockSinks();

        return this;
    },

    'modify': function(func, context) {
        return this.set(func.call(context || this, this.value));
    },

    'remove': function() {
        return this.set(undefined);
    },

    'setCalculation': function(calc) {
        util.assert(this.calculation === null, 'duplicate calculation: ' + this.name);

        this.calculation = calc;
        this.debugName() && console.log('%o(%o) calculation=%o', this, this.name, this.calculation);

        _.each(calc.sources, function(name) {
            var source = this.broker.properties.get(name);
            this.addSource(source);
            source.addSink(this);
        }, this);
        return this;
    },

    'removeCalculation': function(calculation) {
        util.assert(this.calculation === calculation, 'invalid calculation removal: ' + this.name);
        this.calculation = null;
        this.debugName() && console.log('%o(%o) calculation=%o', this, this.name, this.calculation);

        this.sources._('each', function(source) {
            this.removeSource(source);
            source.removeSink(this);
        }, this);
        return this;
    }
});


function NodeSet() {
    util.Set.apply(this, arguments);
};
util.makePrototype(NodeSet, util.Set, {
    'makeKey': function(node) {
        return node.id;
    }
});


exports.DataBroker = DataBroker;
