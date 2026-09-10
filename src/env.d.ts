/// <reference types="vite/client" />
/// <reference types="vite-plugin-glsl/ext" />

interface Window {
  /** The engine, exposed for the output window handshake and app hot-swapping. */
  __revoltage?: import('./engine/engine').Engine;
}
