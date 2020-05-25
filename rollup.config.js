import nodeResolve from 'rollup-plugin-node-resolve'
import {terser} from 'rollup-plugin-terser'

export default {
  input: 'src/index.js',
  output: [
    {
      format: 'iife',
      file: 'dist/aframe-troika-text.js',
      globals: {
        three: 'THREE',
        aframe: 'AFRAME'
      }
    },
    {
      format: 'iife',
      file: 'dist/aframe-troika-text.min.js',
      globals: {
        three: 'THREE',
        aframe: 'AFRAME'
      },
      sourcemap: true,
      plugins: [
        terser()
      ]
    }
  ],
  external: ['three', 'aframe'],
  plugins: [
    nodeResolve()
  ]
}
