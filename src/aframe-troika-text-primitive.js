import aframe from 'aframe'
import {COMPONENT_NAME} from './aframe-troika-text-component.js'


var mappings = {}

// From aframe's primitives.js utilities...
var schema = aframe.components[COMPONENT_NAME].schema
Object.keys(schema).map(function (prop) {
  // Hyphenate where there is camelCase.
  var attrName = prop.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  mappings[attrName] = COMPONENT_NAME + '.' + prop;
});


aframe.registerPrimitive('a-troika-text', {
  defaultComponents: {
    'troika-text': {}
  },
  mappings: mappings
})

