import aframe from 'aframe'

// Use the standalone TextMesh build file to avoid a large tree of Troika framework dependencies
import {TextMesh} from 'troika-3d-text/dist/textmesh-standalone.esm.js'


export var COMPONENT_NAME = 'troika-text'


aframe.registerComponent(COMPONENT_NAME, {
  schema: {
    align: {type: 'string', default: 'left', oneOf: ['left', 'right', 'center']},
    anchor: {default: 'center', oneOf: ['left', 'right', 'center', 'align']},
    baseline: {default: 'center', oneOf: ['top', 'center', 'bottom']},
    clipRect: {
      type: 'string',
      default: '',
      parse: function(value) {
        if (value) {
          value = value.split(/[\s,]+/).reduce(function(out, val) {
            val = +val
            if (!isNaN(val)) {
              out.push(val)
            }
            return out
          }, [])
        }
        return value && value.length === 4 ? value : null
      },
      stringify: function(value) {
        return value ? value.join(' ') : ''
      }
    },
    color: {type: 'color', default: '#FFF'},
    font: {type: 'string'},
    fontSize: {type: 'number', default: 0.2},
    letterSpacing: {type: 'number', default: 0},
    lineHeight: {type: 'number'},
    maxWidth: {type: 'number', default: Infinity},
    overflowWrap: {type: 'string', default: 'normal', oneOf: ['normal', 'break-word']},
    value: {type: 'string'},
    whiteSpace: {default: 'normal', oneOf: ['normal', 'nowrap']}

    // attrs that can be configured via troika-text-material:
    // opacity: {type: 'number', default: 1.0},
    // transparent: {default: true},
    // side: {default: 'front', oneOf: ['front', 'back', 'double']},
  },

  /**
   * Called once when component is attached. Generally for initial setup.
   */
  init: function () {
    // If we're being applied as a component attached to a generic a-entity, create an
    // anonymous sub-entity that we can use to isolate the text mesh and the material
    // component that should apply to it. If we're a primitive, no isolation is needed.
    var textEntity
    var isPrimitive = this.el.tagName.toLowerCase() === 'a-troika-text'
    if (isPrimitive) {
      textEntity = this.el
    } else {
      textEntity = document.createElement('a-entity')
      this.el.appendChild(textEntity)
    }
    this.troikaTextEntity = textEntity

    // Create TextMesh and add it to the entity as the 'mesh' object
    var textMesh = this.troikaTextMesh = new TextMesh()
    textMesh.anchor = [0, 0]
    textEntity.setObject3D('mesh', textMesh)
  },

  /**
   * Called when component is attached and when component data changes.
   * Generally modifies the entity based on the data.
   */
  update: function () {
    var data = this.data
    var mesh = this.troikaTextMesh
    var entity = this.troikaTextEntity

    // Update the text mesh
    mesh.text = (data.value || '')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
    mesh.textAlign = data.align

    mesh.anchorX = anchorMapping[data.anchor === 'align' ? data.align : data.anchor] || 'center'
    mesh.anchorY = baselineMapping[data.baseline] || 'middle'
    mesh.color = data.color
    mesh.clipRect = data.clipRect
    mesh.depthOffset = data.depthOffset || 0
    mesh.font = data.font //TODO allow aframe stock font names
    mesh.fontSize = data.fontSize
    mesh.letterSpacing = data.letterSpacing || 0
    mesh.lineHeight = data.lineHeight || 'normal'
    mesh.overflowWrap = data.overflowWrap
    mesh.whiteSpace = data.whiteSpace
    mesh.maxWidth = data.maxWidth
    mesh.sync()

    // Pass material config down to child entity
    if (entity !== this.el) {
      var materialAttr = this.el.getAttribute('troika-text-material')
      if (materialAttr) {
        entity.setAttribute('material', materialAttr)
      } else {
        entity.removeAttribute('material')
      }
    }
  },

  /**
   * Called when a component is removed (e.g., via removeAttribute).
   * Generally undoes all modifications to the entity.
   */
  remove: function () {
    // Free memory
    this.troikaTextMesh.dispose()

    // If using sub-entity, remove it
    if (this.troikaTextEntity !== this.el) {
      this.el.removeChild(this.troikaTextEntity)
    }
  }

})


var anchorMapping = {
  'left': 'left',
  'center': 'center',
  'right': 'right'
}
var baselineMapping = {
  'top': 'top',
  'center': 'middle',
  'bottom': 'bottom'
}

