import aframe from 'aframe'
import { Text } from 'troika-three-text'


export var COMPONENT_NAME = 'troika-text'

function numberOrPercent(defaultValue) {
  return {
    default: defaultValue,
    parse: function(value) {
      if (typeof value === 'string' && value.indexOf('%') > 0) {
        return value
      }
      value = +value
      return isNaN(value) ? 0 : value
    },
    stringify: function(value) {
      return '' + value
    }
  }
}

aframe.registerComponent(COMPONENT_NAME, {
  schema: {
    align: {type: 'string', default: 'left', oneOf: ['left', 'right', 'center', 'justify']},
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
    colorRanges: { // experimental
      type: 'string',
      default: null,
      parse: function(value) {
        return typeof value === 'string' ? JSON.parse(value) : value
      },
      stringify: JSON.stringify
    },
    curveRadius: {type: 'number', default: 0},
    depthOffset: {type: 'number', default: 0},
    direction: {type: 'string', default: 'auto', oneOf: ['auto', 'ltr', 'rtl']},
    fillOpacity: {type: 'number', default: 1},
    font: {type: 'string'},
    fontSize: {type: 'number', default: 0.2},
    letterSpacing: {type: 'number', default: 0},
    lineHeight: {type: 'number'},
    maxWidth: {type: 'number', default: Infinity},
    outlineBlur: numberOrPercent(0),
    outlineColor: {type: 'color', default: '#000'},
    outlineOffsetX: numberOrPercent(0),
    outlineOffsetY: numberOrPercent(0),
    outlineOpacity: {type: 'number', default: 1},
    outlineWidth: numberOrPercent(0),
    overflowWrap: {type: 'string', default: 'normal', oneOf: ['normal', 'break-word']},
    strokeColor: {type: 'color', default: 'grey'},
    strokeOpacity: {type: 'number', default: 1},
    strokeWidth: numberOrPercent(0),
    textIndent: {type: 'number', default: 0},
    unicodeFontsURL: {type: 'string', default: ''},
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

    // Create Text mesh and add it to the entity as the 'mesh' object
    var textMesh = this.troikaTextMesh = new Text()
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
    var font = data.font

    // Update the text mesh
    mesh.text = (data.value || '')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
    mesh.textAlign = data.align

    // Retrieve font path if preloaded in <a-assets> with unique id
    if (data.font.startsWith('#')) {
      const assetItem = document.querySelector(data.font);
      font = assetItem.getAttribute('src');
    }

    mesh.anchorX = anchorMapping[data.anchor === 'align' ? data.align : data.anchor] || 'center'
    mesh.anchorY = baselineMapping[data.baseline] || 'middle'
    mesh.color = data.color
    mesh.colorRanges = data.colorRanges
    mesh.clipRect = data.clipRect
    mesh.curveRadius = data.curveRadius
    mesh.depthOffset = data.depthOffset || 0
    mesh.direction = data.direction
    mesh.fillOpacity = data.fillOpacity
    mesh.font = font //TODO allow aframe stock font names
    mesh.fontSize = data.fontSize
    mesh.letterSpacing = data.letterSpacing || 0
    mesh.lineHeight = data.lineHeight || 'normal'
    mesh.outlineBlur = data.outlineBlur
    mesh.outlineColor = data.outlineColor
    mesh.outlineOffsetX = data.outlineOffsetX
    mesh.outlineOffsetY = data.outlineOffsetY
    mesh.outlineOpacity = data.outlineOpacity
    mesh.outlineWidth = data.outlineWidth
    mesh.overflowWrap = data.overflowWrap
    mesh.strokeColor = data.strokeColor
    mesh.strokeOpacity = data.strokeOpacity
    mesh.strokeWidth = data.strokeWidth
    mesh.textIndent = data.textIndent
    mesh.unicodeFontsURL = data.unicodeFontsURL
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

