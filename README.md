## aframe-troika-text

[![Version](http://img.shields.io/npm/v/aframe-troika-text.svg?style=flat-square)](https://npmjs.org/package/aframe-troika-text)
[![License](http://img.shields.io/npm/l/aframe-troika-text.svg?style=flat-square)](https://npmjs.org/package/aframe-troika-text)

This package provides an [A-Frame](https://aframe.io) component and primitive for rendering three-dimensional text using [Troika's text renderer](https://github.com/protectwise/troika/tree/master/packages/troika-three-text).

It has similar performance and quality to A-Frame's built-in SDF `text` component, but brings some additional advantages:

* It reads font files directly (ttf, otf, woff) and does not require using an external tool to pre-generate SDF textures with the glyphs you think you'll need.

* It supports ligatures so you can use fonts like [Material Icons](https://material.io/resources/icons/).

* Rather than using a fully custom shader, it patches the built-in Three.js material shaders as needed, so you don't lose all the nice standard shader features like lighting and fog.

* Support for right-to-left/bidirectional language layout and shaping of Arabic text.


### API

This package registers both a _component_ (`<a-entity troika-text="value:Hello" />`) and a _primitive_ (`<a-troika-text value="Hello"></a-troika-text>`). Use whichever is most convenient for you.

I've attempted to keep the API as close as possible to that of A-Frame's default [text component](https://aframe.io/docs/master/components/text.html) and [a-text primitive](https://aframe.io/docs/master/primitives/a-text.html), however some things don't quite map exactly.

| Property on component | Attribute on primitive | Description                                                                                                 | Default Value                   |
|-----------------------|------------------------|-------------------------------------------------------------------------------------------------------------|---------------------------------|
| align                 | align                  | Multi-line text alignment (left, center, right, justify).                                                   | left                            |
| anchor                | anchor                 | Horizontal positioning (left, center, right, align).                                                        | center                          |
| baseline              | baseline               | Vertical positioning (top, center, bottom).                                                                 | center                          |
| clipRect              | clip-rect              | Four comma- or space-separated numbers defining a rectangle (minX, minY, maxX, maxY) outside which pixels will be hidden. | *no clipping*     |
| curveRadius           | curve-radius           | A cylindrical radius along which the text's plane will be curved. Positive = concave, negative = convex.    | 0                               |
| color                 | color                  | Text color. This is a shortcut for specifying a custom material.                                            | white                           |
| depthOffset           | depth-offset           | Depth buffer offset to help prevent z-fighting. Negative numbers are closer to camera, positives further.   | 0                               |
| direction             | direction              | Main bidi direction of the text: 'auto', 'ltr', or 'rtl'                                                    | 'auto'                          |
| fillOpacity           | fill-opacity           | Opacity of the glyph's fill.                                                                                | 1                               |
| font                  | font                   | URL to a font file - can be a .ttf, .otf, or .woff (no .woff2) or an `<a-asset-item>` id such as `#font`.   | Roboto loaded from Google Fonts |
| fontSize              | font-size              | Em-height at which to render the font, in meters.                                                           | 0.2                             |
| letterSpacing         | letter-spacing         | Letter spacing in meters.                                                                                   | 0                               |
| lineHeight            | line-height            | Line height as a multiple of the fontSize.                                                                  | *derived from font metrics*     |
| maxWidth              | max-width              | Maximum width of the text block at which text will start wrapping, in meters.                               | Infinity (no wrapping)          |
| outlineBlur           | outline-blur           | A blur radius applied to the outer edge of the text's `outlineWidth`.                                       | 0                               |
| outlineColor          | outline-color          | Color of an outline drawn around the glyph paths.                                                           | black                           |
| outlineOffsetX        | outline-offset-x       | Horizontal offset of the outline (ala text-shadow), as a number in meters or a percentage of the font-size. | 0                               |
| outlineOffsetY        | outline-offset-y       | Vertical offset of the outline (ala text-shadow), as a number in meters or a percentage of the font-size.   | 0                               |
| outlineOpacity        | outline-opacity        | Opacity of the outline, from 0 to 1.                                                                        | 1                               |
| outlineWidth          | outline-width          | Width of an outline drawn around the glyph paths, as a number in meters or a percentage of the font-size.   | 0                               |
| overflowWrap          | overflow-wrap          | Controls how text wraps: "normal" to break at whitespace characters, or "break-word" to break within words. | normal                          |
| **value**             | value                  | The actual content of the text. Line breaks and tabs are supported with `\n` and `\t`.                      | ''                              |
| strokeColor           | stroke-color           | Color of a stroke drawn inside the glyph paths.                                                             | grey                            |
| strokeOpacity         | stroke-opacity         | Opacity of the stroke, from 0 to 1.                                                                         | 1                               |
| strokeWidth           | stroke-width           | Width of a stroke drawn inside the glyph paths, as a number in meters or a percentage of the font-size.     | 0                               |
| textIndent            | text-indent            | Width of an indentation space to be added before the first character of a line.                             | 0                               |
| unicodeFontsURL       | unicode-fonts-url      | Location of [self-hosted font files](https://github.com/lojjic/unicode-font-resolver/blob/1.x/packages/data/README.md#self-hosting). | ''     |
| whiteSpace            | white-space            | How whitespace should be handled (i.e., normal, nowrap).                                                    | normal (behaves like pre-wrap)  |

Note: It does not currently follow how the built-in `text` component interacts with a `geometry` component for auto-sizing and anchoring. I think that's a nice feature so it's probably worth adding; in the meantime just use the `maxWidth` and `anchor`/`baseline` attributes to control it manually.

#### Changing the material

By default the text will render using a `MeshBasicMaterial` using the `color` property described in the table above. But you can also change the material to gain more advanced shader features such as physically-based lighting.

If you are using the `<a-troika-text>` _primitive_, you can assign it a [`material` component](https://aframe.io/docs/master/components/material.html) just as you would any other entity.

```html
<a-troika-text
  value="Hello!"
  material="shader: standard; metalness: 0.8;"
></a-troika-text>
```

If you are using the `troika-text="..."` _component_, you must instead give it a `troika-text-material="..."` attribute to distinguish the text material from the entity's main material. You can pass it anything supported by the built in [`material` component](https://aframe.io/docs/master/components/material.html).

```html
<a-entity
  troika-text="value: Hello!"
  troika-text-material="shader: standard; metalness: 0.8;"
></a-entity>
```

### Installation

#### Browser

Install and use by directly including the [browser files](dist):

```html
<head>
  <title>My A-Frame Scene</title>
  <script src="https://aframe.io/releases/1.3.0/aframe.min.js"></script>
  <script src="https://unpkg.com/aframe-troika-text/dist/aframe-troika-text.min.js"></script>
</head>

<body>
  <a-scene>
    <!-- As a component: -->
    <a-entity troika-text="value: Hello world!"></a-entity>
    
    <!-- As a primitive: -->
    <a-troika-text value="Hello world!"></a-troika-text>
  </a-scene>
</body>
```

#### npm

Install via npm:

```bash
npm install aframe-troika-text
```

Then require and use.

```js
require('aframe');
require('aframe-troika-text');
```
