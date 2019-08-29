import aframe from 'aframe'

// Use the standalone TextMesh build file to avoid a large tree of Troika framework dependencies
import {TextMesh} from 'troika-3d-text/dist/textmesh-standalone.esm.js'


export const COMPONENT_NAME = 'troika-text'


aframe.registerComponent(COMPONENT_NAME, {
  schema: {
    align: {type: 'string', default: 'left', oneOf: ['left', 'right', 'center']},
    anchor: {default: 'center', oneOf: ['left', 'right', 'center', 'align']},
    baseline: {default: 'center', oneOf: ['top', 'center', 'bottom']},
    color: {type: 'color', default: '#FFF'},
    font: {type: 'string'},
    fontSize: {type: 'number', default: 0.2},
    letterSpacing: {type: 'number', default: 0},
    lineHeight: {type: 'number'},
    maxWidth: {type: 'number', default: Infinity},
    overflowWrap: {type: 'string', default: 'normal', oneOf: ['normal', 'break-word']},
    value: {type: 'string'},
    whiteSpace: {default: 'normal', oneOf: ['normal', 'nowrap']}

    // attrs to be handled via text material, once I figure that out:
    // opacity: {type: 'number', default: 1.0},
    // transparent: {default: true},
    // side: {default: 'front', oneOf: ['front', 'back', 'double']},
  },

  /**
   * Called once when component is attached. Generally for initial setup.
   */
  init: function () {
    var textMesh = this.textMesh = new TextMesh()
    textMesh.anchor = [0, 0]
    this.el.setObject3D(this.attrName, this.textMesh)
  },

  /**
   * Called when component is attached and when component data changes.
   * Generally modifies the entity based on the data.
   */
  update: function () {
    var data = this.data
    var mesh = this.textMesh

    console.log(data)

    mesh.text = data.value
    mesh.textAlign = data.align
    mesh.anchor[0] = anchorMapping[data.anchor]
    mesh.anchor[1] = baselineMapping[data.baseline]
    mesh.color = data.color
    mesh.font = data.font //TODO allow aframe stock font names
    mesh.fontSize = data.fontSize
    mesh.letterSpacing = data.letterSpacing || 0
    mesh.lineHeight = data.lineHeight || null
    mesh.overflowWrap = data.overflowWrap
    mesh.whiteSpace = data.whiteSpace
    mesh.maxWidth = data.maxWidth

    mesh.sync()
  },

  /**
   * Called when a component is removed (e.g., via removeAttribute).
   * Generally undoes all modifications to the entity.
   */
  remove: function () {
    this.textMesh.dispose()
    this.el.removeObject3D(this.attrName);
  }

})


var anchorMapping = {
  'left': 0,
  'center': 0.5,
  'right': 1
}
var baselineMapping = {
  'top': 0,
  'center': 0.5,
  'bottom': 1
}

