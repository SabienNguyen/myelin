// A sigma v3 WebGL node program, modelled directly on sigma's own NodeCircleProgram (see
// node_modules/sigma/dist/declarations/src/rendering/programs/node-circle/index.d.ts and its
// compiled source in node_modules/sigma/dist/index-fad77a13.esm.js): same base class, same
// "equilateral triangle circumscribing a disc" vertex trick (three CONSTANT_ATTRIBUTES vertices at
// 120 degrees apart, far enough from the centre that the rasterised triangle fully contains the
// disc), same picking-mode branch reading a_id instead of a_color, same border/border-width style
// of anti-aliasing. It adds two attributes — a_ringFraction (decay arc, -1 when there is none) and
// a_slipped (0/1) — and draws them as a second ring just outside the disc.
import type { Attributes } from 'graphology-types';
import { NodeProgram, numberToGLSLFloat } from 'sigma/rendering';
import type { ProgramInfo } from 'sigma/rendering';
import { colorToArray, floatColor } from 'sigma/utils';
import type { NodeDisplayData, RenderParams } from 'sigma/types';

const UNIFORMS = ['u_sizeRatio', 'u_correctionRatio', 'u_matrix', 'u_warnColor'] as const;

// The enclosing quad is the same "triangle circumscribing a circle" sigma's NodeCircleProgram
// builds, inflated for a node that draws a ring: NodeCircleProgram sizes its triangle to exactly
// touch the disc, so a ring drawn outside that disc would be clipped by the rasterizer. Only ringed
// nodes get the bigger quad (the vertex shader decides, so processVisibleItem stays identical to
// sigma's own). Inflating every node cost ~2.1x the fragments for pixels that are always
// transparent, and on a software rasterizer — headless Chromium's SwiftShader, where
// graph-perf.e2e.ts runs — fragment shading is most of the frame.
const RING_QUAD_SCALE = 1.45;

// Ring geometry, as fractions of the node's own (unscaled) radius.
const RING_GAP_FRACTION = 0.18;
const RING_STROKE_FRACTION = 0.14;
const RING_MIN_STROKE_PX = 1.5;
const RING_DASH_COUNT = 12;

interface MasteryNodeDisplayData extends NodeDisplayData {
  ringFraction: number | null;
  slipped: boolean;
}

// language=GLSL
const VERTEX_SHADER_SOURCE = /*glsl*/ `
attribute vec4 a_id;
attribute vec4 a_color;
attribute vec2 a_position;
attribute float a_size;
attribute float a_angle;
attribute float a_ringFraction;
attribute float a_slipped;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;

varying vec4 v_color;
varying vec2 v_diffVector;
varying float v_radius;
varying float v_ringFraction;
varying float v_slipped;

const float bias = 255.0 / 254.0;

void main() {
  // radius is the disc's true radius, in the same graph-space units edges use for node size
  // (matches NodeCircleProgram's v_radius = a_size * correctionRatio / sizeRatio * 2.0 exactly, so
  // this program's disc lines up with edges sized against the same node).
  float radius = a_size * u_correctionRatio / u_sizeRatio * 2.0;
  bool hasRing = a_ringFraction >= 0.0 || a_slipped > 0.5;
  float quadRadius = radius * (hasRing ? ${numberToGLSLFloat(RING_QUAD_SCALE)} : 1.0);
  vec2 diffVector = quadRadius * 2.0 * vec2(cos(a_angle), sin(a_angle));
  vec2 position = a_position + diffVector;
  gl_Position = vec4((u_matrix * vec3(position, 1)).xy, 0, 1);

  v_diffVector = diffVector;
  v_radius = radius;
  v_ringFraction = a_ringFraction;
  v_slipped = a_slipped;

  #ifdef PICKING_MODE
  // For picking mode, we use the ID as the color:
  v_color = a_id;
  #else
  // For normal mode, we use the color:
  v_color = a_color;
  #endif

  v_color.a *= bias;
}
`;

// language=GLSL
const FRAGMENT_SHADER_SOURCE = /*glsl*/ `
precision highp float;

varying vec4 v_color;
varying vec2 v_diffVector;
varying float v_radius;
varying float v_ringFraction;
varying float v_slipped;

uniform float u_correctionRatio;
uniform vec4 u_warnColor;

const vec4 transparent = vec4(0.0, 0.0, 0.0, 0.0);
const float PI = 3.14159265358979;
const float GAP_FRACTION = ${numberToGLSLFloat(RING_GAP_FRACTION)};
const float STROKE_FRACTION = ${numberToGLSLFloat(RING_STROKE_FRACTION)};
const float MIN_STROKE_PX = ${numberToGLSLFloat(RING_MIN_STROKE_PX)};
const float DASH_COUNT = ${numberToGLSLFloat(RING_DASH_COUNT)};

// Coverage of "inside radius r", faded to 0 over a ~2*border band around the edge — this is
// sigma's own circle program's dist/border anti-aliasing, pulled into a function so it can be
// reused for both the disc's edge and the ring's inner/outer edges.
float edgeCoverage(float dist, float r, float border) {
  float d = r - dist + border;
  if (d > border) return 1.0;
  if (d > 0.0) return d / border;
  return 0.0;
}

void main(void) {
  float dist = length(v_diffVector);
  float border = u_correctionRatio * 2.0;
  float minStroke = u_correctionRatio * MIN_STROKE_PX;
  float strokeWidth = max(v_radius * STROKE_FRACTION, minStroke);
  float ringInner = v_radius * (1.0 + GAP_FRACTION);
  float ringOuter = ringInner + strokeWidth;

  bool hasRing = v_ringFraction >= 0.0 || v_slipped > 0.5;

  #ifdef PICKING_MODE
  // No antialiasing for picking mode. Hit-test the node's full visual footprint — the disc alone
  // when it carries no ring, disc+ring when it does — so hovering the ring picks the node too.
  float pickRadius = hasRing ? ringOuter : v_radius;
  gl_FragColor = dist <= pickRadius ? v_color : transparent;

  #else
  vec4 color = mix(transparent, v_color, edgeCoverage(dist, v_radius, border));

  // Decay arc: from 12 o'clock, clockwise, for ringFraction * 2*PI, in the node's own colour.
  if (v_ringFraction >= 0.0) {
    float angle = atan(v_diffVector.x, v_diffVector.y);
    if (angle < 0.0) angle += 2.0 * PI;
    if (angle <= v_ringFraction * 2.0 * PI) {
      float band = clamp(edgeCoverage(dist, ringOuter, border) - edgeCoverage(dist, ringInner, border), 0.0, 1.0);
      color = mix(color, v_color, band);
    }
  }

  // Slipped: a full dashed ring in the warn colour, drawn over the decay arc.
  if (v_slipped > 0.5) {
    float angle = atan(v_diffVector.x, v_diffVector.y);
    if (angle < 0.0) angle += 2.0 * PI;
    float dashPhase = fract(angle / (2.0 * PI) * DASH_COUNT);
    if (dashPhase < 0.5) {
      float band = clamp(edgeCoverage(dist, ringOuter, border) - edgeCoverage(dist, ringInner, border), 0.0, 1.0);
      color = mix(color, u_warnColor, band);
    }
  }

  gl_FragColor = color;
  #endif
}
`;

export class MasteryNodeProgram<
  N extends Attributes = Attributes,
  E extends Attributes = Attributes,
  G extends Attributes = Attributes,
> extends NodeProgram<(typeof UNIFORMS)[number], N, E, G> {
  static readonly ANGLE_1 = 0;
  static readonly ANGLE_2 = (2 * Math.PI) / 3;
  static readonly ANGLE_3 = (4 * Math.PI) / 3;

  // The "slipped" ring's colour (a '#rrggbb' CSS token, e.g. resolveGraphColors().warn). A static
  // rather than a constructor argument: sigma's `nodeProgramClasses` setting takes a bare
  // constructor and instantiates it itself, so there is no call site for us to thread config
  // through — T4 sets this once, from resolveGraphColors(), before constructing Sigma.
  static warnColor = '#e5c17e';

  getDefinition() {
    return {
      VERTICES: 3,
      VERTEX_SHADER_SOURCE,
      FRAGMENT_SHADER_SOURCE,
      METHOD: WebGLRenderingContext.TRIANGLES,
      UNIFORMS,
      ATTRIBUTES: [
        { name: 'a_position', size: 2, type: WebGLRenderingContext.FLOAT },
        { name: 'a_size', size: 1, type: WebGLRenderingContext.FLOAT },
        { name: 'a_color', size: 4, type: WebGLRenderingContext.UNSIGNED_BYTE, normalized: true },
        { name: 'a_id', size: 4, type: WebGLRenderingContext.UNSIGNED_BYTE, normalized: true },
        { name: 'a_ringFraction', size: 1, type: WebGLRenderingContext.FLOAT },
        { name: 'a_slipped', size: 1, type: WebGLRenderingContext.FLOAT },
      ],
      CONSTANT_ATTRIBUTES: [{ name: 'a_angle', size: 1, type: WebGLRenderingContext.FLOAT }],
      CONSTANT_DATA: [[MasteryNodeProgram.ANGLE_1], [MasteryNodeProgram.ANGLE_2], [MasteryNodeProgram.ANGLE_3]],
    };
  }

  processVisibleItem(nodeIndex: number, startIndex: number, data: NodeDisplayData): void {
    const node = data as MasteryNodeDisplayData;
    const array = this.array;
    let i = startIndex;
    array[i++] = node.x;
    array[i++] = node.y;
    array[i++] = node.size;
    array[i++] = floatColor(node.color);
    array[i++] = nodeIndex;
    array[i++] = node.ringFraction ?? -1;
    array[i++] = node.slipped ? 1 : 0;
  }

  setUniforms(params: RenderParams, { gl, uniformLocations }: ProgramInfo): void {
    const { u_sizeRatio, u_correctionRatio, u_matrix, u_warnColor } = uniformLocations;
    gl.uniform1f(u_correctionRatio, params.correctionRatio);
    gl.uniform1f(u_sizeRatio, params.sizeRatio);
    gl.uniformMatrix3fv(u_matrix, false, params.matrix);
    // A uniform can't use a_color's vertex-buffer trick (storing a packed float and letting
    // vertexAttribPointer's UNSIGNED_BYTE type reinterpret its raw bytes) — colorToArray runs that
    // same floatColor parse and hands back the four 0..255 byte components instead, which a plain
    // gl.uniform4f can take once normalized to 0..1.
    const [r, g, b, a] = colorToArray(MasteryNodeProgram.warnColor);
    gl.uniform4f(u_warnColor, r / 255, g / 255, b / 255, a / 255);
  }
}
