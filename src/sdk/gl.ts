import * as twgl from 'twgl.js';

const VERT = `#version 300 es
in vec2 position;
out vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

export interface FullscreenShader {
  /** Draw to `target` (or the canvas when null/omitted). Viewport follows the target. */
  draw(uniforms: Record<string, unknown>, target?: twgl.FramebufferInfo | null): void;
  dispose(): void;
}

/** A fragment shader drawn over a fullscreen triangle. The fragment gets `in vec2 vUv`. */
export function fullscreenShader(gl: WebGL2RenderingContext, frag: string): FullscreenShader {
  let error = '';
  const program = twgl.createProgramInfo(gl, [VERT, frag], { errorCallback: (msg: string) => (error = msg) });
  if (!program) throw new Error(`shader failed to compile:\n${error}`);
  const tri = twgl.createBufferInfoFromArrays(gl, {
    position: { numComponents: 2, data: [-1, -1, 3, -1, -1, 3] },
  });
  return {
    draw(uniforms, target = null) {
      twgl.bindFramebufferInfo(gl, target);
      gl.useProgram(program.program);
      twgl.setBuffersAndAttributes(gl, program, tri);
      twgl.setUniforms(program, uniforms);
      twgl.drawBufferInfo(gl, tri);
    },
    dispose() {
      gl.deleteProgram(program.program);
    },
  };
}

export interface PingPong {
  /** Last frame's result: sample this. */
  readonly read: twgl.FramebufferInfo;
  /** Render into this, then call swap(). */
  readonly write: twgl.FramebufferInfo;
  readonly readTexture: WebGLTexture;
  swap(): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

/** Two framebuffers for feedback effects. Half-float when available, to avoid banding in trails. */
export function pingPong(gl: WebGL2RenderingContext, width: number, height: number): PingPong {
  const float = !!gl.getExtension('EXT_color_buffer_float');
  const attachments = [{
    internalFormat: float ? gl.RGBA16F : gl.RGBA8,
    format: gl.RGBA,
    type: float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
    min: gl.LINEAR,
    mag: gl.LINEAR,
    wrap: gl.CLAMP_TO_EDGE,
  }];
  let a = twgl.createFramebufferInfo(gl, attachments, width, height);
  let b = twgl.createFramebufferInfo(gl, attachments, width, height);
  const free = (f: twgl.FramebufferInfo) => {
    gl.deleteFramebuffer(f.framebuffer);
    for (const t of f.attachments) gl.deleteTexture(t as WebGLTexture);
  };
  return {
    get read() { return a; },
    get write() { return b; },
    get readTexture() { return a.attachments[0] as WebGLTexture; },
    swap() { [a, b] = [b, a]; },
    resize(w, h) {
      twgl.resizeFramebufferInfo(gl, a, attachments, w, h);
      twgl.resizeFramebufferInfo(gl, b, attachments, w, h);
    },
    dispose() { free(a); free(b); },
  };
}
