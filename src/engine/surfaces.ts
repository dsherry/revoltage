import type { Surface, SurfaceKind } from '@sdk';

export interface SurfaceHandle {
  readonly surface: Surface<SurfaceKind>;
  readonly canvas: HTMLCanvasElement;
  resize(width: number, height: number): void;
  dispose(): void;
}

const CANVAS_STYLE = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;';

/** One fresh canvas per mounted app. Disposal forces the GL context to be released. */
export async function createSurface(
  kind: SurfaceKind,
  parent: HTMLElement,
  width: number,
  height: number,
  onContextLost: () => void,
): Promise<SurfaceHandle> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = CANVAS_STYLE;

  const surface: Record<string, unknown> = { canvas, width, height, pixelRatio: 1 };
  let onResize = (_w: number, _h: number): void => {};
  let onDispose = (): void => {};

  switch (kind) {
    case '2d': {
      const g2d = canvas.getContext('2d', { alpha: false });
      if (!g2d) throw new Error('2D canvas context unavailable');
      surface.g2d = g2d;
      break;
    }
    case 'webgl2': {
      const gl = canvas.getContext('webgl2', {
        alpha: false, antialias: false, premultipliedAlpha: false,
        preserveDrawingBuffer: false, powerPreference: 'high-performance',
      });
      if (!gl) throw new Error('WebGL2 context unavailable');
      surface.gl = gl;
      onDispose = () => gl.getExtension('WEBGL_lose_context')?.loseContext();
      break;
    }
    case 'three': {
      const THREE = await import('three');
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      surface.renderer = renderer;
      onResize = (w, h) => renderer.setSize(w, h, false);
      onDispose = () => { renderer.dispose(); renderer.forceContextLoss(); };
      break;
    }
    case 'p5':
      throw new Error('the p5 surface is not implemented yet (M9)');
  }

  let disposed = false;
  canvas.addEventListener('webglcontextlost', (e) => {
    if (disposed) return;
    e.preventDefault();
    onContextLost();
  });
  parent.appendChild(canvas);

  return {
    surface: surface as unknown as Surface<SurfaceKind>,
    canvas,
    resize(w, h) {
      if (kind !== 'three') { canvas.width = w; canvas.height = h; }
      surface.width = w;
      surface.height = h;
      onResize(w, h);
    },
    dispose() {
      disposed = true;
      try { onDispose(); } finally { canvas.remove(); }
    },
  };
}
