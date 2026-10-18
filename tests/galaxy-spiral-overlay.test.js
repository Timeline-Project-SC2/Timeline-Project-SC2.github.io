'use strict';

var assert = require('node:assert/strict');
var GalaxySpiral = require('../site/shared/galaxy-spiral.js');

function element(name) {
  return {
    nodeName: name,
    style: {},
    children: [],
    parentNode: null,
    setAttribute: function () {},
    getContext: function () { return {}; },
    addEventListener: function () {},
    removeEventListener: function () {},
    appendChild: function (child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    insertBefore: function (child, anchor) {
      var index = this.children.indexOf(anchor);
      if (index < 0) return this.appendChild(child);
      child.parentNode = this;
      this.children.splice(index, 0, child);
      return child;
    },
    removeChild: function (child) {
      var index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentNode = null;
    }
  };
}

var oldDocument = global.document;
var oldWindow = global.window;
var listeners = {};
global.document = {
  hidden: false,
  createElement: function (name) { return element(name); },
  addEventListener: function (name, fn) { listeners[name] = fn; },
  removeEventListener: function (name) { delete listeners[name]; }
};
global.window = {};

try {
  var layer = element('div');
  var image = element('img');
  image.complete = false;
  image.currentSrc = '/assets/galaxy-map.webp';
  image.src = image.currentSrc;
  var lagLayer = element('div');
  lagLayer.className = 'lag-fx';
  layer.appendChild(image);
  layer.appendChild(lagLayer);

  var overlay = GalaxySpiral.overlay({
    layer: layer,
    image: image,
    before: lagLayer,
    center: [0.5, 0.5],
    radius: 0.4,
    view: function () { return null; }
  });

  assert.ok(overlay, 'overlay should be created before the map image finishes loading');
  assert.equal(layer.children.indexOf(overlay.el), 1, 'spiral canvas should be immediately above the map');
  assert.ok(layer.children.indexOf(overlay.el) < layer.children.indexOf(lagLayer),
    'lag and digital-defect layers must paint over the spiral');

  overlay.destroy();
  assert.equal(layer.children.indexOf(overlay.el), -1, 'destroy should remove the spiral canvas');
} finally {
  global.document = oldDocument;
  global.window = oldWindow;
}

console.log('galaxy-spiral overlay tests passed');
