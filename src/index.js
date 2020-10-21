import * as THREE from 'three'

// Polyfill Three's rename of Math->MathUtils after the super-three fork
(function(ThreedleDum) {
  if (!ThreedleDum.MathUtils) {
    ThreedleDum.MathUtils = ThreedleDum.Math
  }
})(THREE)

import './aframe-troika-text-component.js'
import './aframe-troika-text-primitive.js'