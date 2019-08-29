import nodeResolve from 'rollup-plugin-node-resolve'
import {terser} from 'rollup-plugin-terser'


const base = {
  input: 'src/index.js',
  output: {
    format: 'iife',
    file: 'dist/aframe-troika-text.js',
    globals: {
      three: 'THREE',
      aframe: 'AFRAME'
    }
  },
  external: ['three', 'aframe']
}

export default [
  // Full:
  {
    input: 'src/index.js',
    output: {
      format: 'iife',
      file: 'dist/aframe-troika-text.js',
      globals: {
        three: 'THREE',
        aframe: 'AFRAME'
      }
    },
    external: ['three', 'aframe'],
    plugins: [
      nodeResolve()
    ]
  },

  // Minified:
  {
    input: 'src/index.js',
    output: {
      format: 'iife',
      file: 'dist/aframe-troika-text.min.js',
      globals: {
        three: 'THREE',
        aframe: 'AFRAME'
      },
      sourcemap: true
    },
    external: ['three', 'aframe'],
    plugins: [
      nodeResolve(),
      terser()
    ]
  }
]