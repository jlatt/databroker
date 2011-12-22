'use strict';
var _ = require('underscore');
var assert = require('assert');
var DataBroker = require('./broker.js').DataBroker;


function run(test) {
    try {
        var broker = new DataBroker();
        test(broker);
        broker.destroy();
    } catch (ex) {
        console.error(ex.stack);
    }
};


run(function testGetSet(broker) {
    broker.set('foo', true);
    broker.set('bar', false);
    broker.set('baz', null);

    assert.ok(broker.has('foo'), 'should have foo');
    assert.ok(broker.has('bar'), 'should have bar');
    assert.ok(broker.has('baz'), 'should have baz');
    assert.ok(!broker.has('xyzzy'), 'should not have xyzzy');

    broker.set('baz');
    assert.ok(!broker.has('baz'), 'should not have baz');
    assert.strictEqual(broker.get('foo'), true, 'foo should be true');
});

run(function testRequest(broker) {
    var triggered = false;
    broker.request({
        'name': 'foo',
        'value': function(v) {
            assert.strictEqual(v, 10, 'v should be 10');
            triggered = true;
        }
    });
    broker.set('foo', 10);
    assert.ok(triggered, 'did not trigger');
});

run(function testCalculation(broker) {
    var triggered = false;

    broker.calculate({
        'target': 'd',
        'sources': ['a', 'b', 'c'],
        'calculate': function(values) {
            return values['a'] + values['b'] + values['c'];
        }
    });

    broker.request({
        'name': 'd',
        'value': function(v) {
            assert.strictEqual(9, v, 'd is 9');
            triggered = true;
        }
    });

    assert.ok(!broker.has('d'), 'd is not present');

    _.each({'a': 1, 'b': 3, 'c': 5}, function(v, k) {
        broker.set(k, v);
    });

    assert.ok(broker.has('d'), 'd is present');
    assert.ok(triggered, 'did not trigger');
});

run(function deferredCalculation(broker) {
    var deferred = $.Deferred();
    broker.calculate({
        'target': 'bar',
        'sources': ['foo'],
        'calculate': function(values) {
            return deferred;
        }
    });
    broker.request('bar');
    broker.set('foo', true);
    assert.ok(!broker.has('bar'), 'broker should not have bar');
    deferred.resolve(5);
    assert.ok(broker.has('bar'), 'broker should have bar');
    assert.strictEqual(5, broker.get('bar'));
});

// Test a dependency tree. Following lines indicate dependency.
// A
// |\
// B |
// |\|
// | C
// |/|
// D |
//  \|
//   E
run(function testCalculationChain1(broker) {
    var calcCount = 0;
    var eCount = 0;
    var e;

    broker.calculate({
        'target': 'a',
        'sources': ['b', 'c'],
        'calculate': function(sources) {
            calcCount++;
            return 1 + sources['b'] + sources['c'];
        }
    });
    broker.calculate({
        'target': 'b',
        'sources': ['c', 'd'],
        'calculate': function(sources) {
            calcCount++;
            return 1 + sources['c'] + sources['d'];
        }
    });
    broker.calculate({
        'target': 'c',
        'sources': ['d', 'e'],
        'calculate': function(sources) {
            calcCount++;
            return 1 + sources['d'] + sources['e'];
        }
    });
    broker.calculate({
        'target': 'd',
        'sources': ['e'],
        'calculate': function(sources) {
            calcCount++;
            return 1 + sources['e'];
        }
    });

    broker.request({
        'name': 'a',
        'value': function(a) {
            assert.strictEqual(a, 7 + (5*e));
            eCount++;
        }
    });

    _.each([1, 2, 3], function(v) {
        e = v;
        broker.set('e', e);
    });

    assert.strictEqual(eCount, 3);
    assert.strictEqual(calcCount, 12);
});

// Test a dependency tree. Following lines indicate dependency.
// A
// |\
// B C
// | |
// | D
// | |
// | E
//  \|
//   F
run(function testcalculationChain2(broker) {
    var calcCount = 0;
    var reqCount = 0;
    var f;

    broker.calculate({
        'target': 'a',
        'sources': ['b', 'c'],
        'calculate': function(sources) {
            calcCount++;
            return sources['b'] + sources['c'];
        }
    });
    broker.calculate({
        'target': 'b',
        'sources': ['f'],
        'calculate': function(sources) {
            calcCount++;
            return sources['f'];
        }
    });
    broker.calculate({
        'target': 'c',
        'sources': ['d'],
        'calculate': function(sources) {
            calcCount++;
            return sources['d'];
        }
    });
    broker.calculate({
        'target': 'd',
        'sources': ['e'],
        'calculate': function(sources) {
            calcCount++;
            return sources['e'];
        }
    });
    broker.calculate({
        'target': 'e',
        'sources': ['f'],
        'calculate': function(sources) {
            calcCount++;
            return sources['f'];
        }
    });

    broker.request({
        'name': 'a',
        'value': function(a) {
            assert.strictEqual(a, 2 * f, 'test f');
            reqCount++;
        }
    });

    _.each([1, 2, 3], function(v) {
        f = v;
        broker.set('f', f);
    }, this);

    assert.strictEqual(calcCount, 15);
    assert.strictEqual(reqCount, 3);
});

run(function testCalculationClosedCycle(broker) {
    var assertCount = 0;

    broker.calculate({
        'target': 'a',
        'sources': ['b'],
        'calculate': function(sources) {
            return Math.min(1 + sources['b'], 4);
        }
    });
    broker.calculate({
        'target': 'b',
        'sources': ['c'],
        'calculate': function(sources) {
            return Math.min(1 + sources['c'], 4);
        }
    });
    broker.calculate({
        'target': 'c',
        'sources': ['a'],
        'calculate': function(sources) {
            return Math.min(1 + sources['a'], 4);
        }
    });

    broker.request({
        'name': 'a',
        'expected': [2, 4],
        'value': function(a) {
            assert.strictEqual(a, this.expected.shift());
            assertCount++;
        }
    });
    broker.request({
        'name': 'b',
        'expected': [1, 4],
        'value': function(b) {
            assert.strictEqual(b, this.expected.shift());
            assertCount++;
        }
    });
    broker.request({
        'name': 'c',
        'expected': [0, 3, 4],
        'value': function(c) {
            assert.strictEqual(c, this.expected.shift());
            assertCount++;
        }
    });

    broker.set('c', 0);

    assert.strictEqual(assertCount, 7);
});
