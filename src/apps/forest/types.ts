import type * as THREE from 'three';

/** Smoothed audio and control inputs, computed once per frame by the Forest app and shared by every scene. */
export interface ForestInputs {
  /** Seconds, scaled by the speed param (use for growth, flow and drift). */
  t: number;
  /** Seconds since the last frame, scaled by the speed param. */
  dt: number;
  /** Real seconds since the last frame (for fades that shouldn't follow speed). */
  realDt: number;
  /** Smoothed by the calm param; roughly 0..1 (adaptive to the input's loudness). */
  level: number;
  bass: number;
  mid: number;
  treble: number;
  /** A note/hit this frame (already gated by the charge param), or the APC strike button. */
  onset: boolean;
  /** 0..1. */
  onsetStrength: number;
  /**
   * Real input level on the Mixer meter's 0..1 scale (-60..0 dBFS), gated by sensitivity and lightly
   * smoothed. Not loudness-normalized: use it when "more sound" should mean "more of something".
   */
  loudness: number;
  /** Pitch of the hit on a log scale, 0 = C2 … 1 = C7, when a clear pitch was detected. */
  pitch: number | null;
  /** 1 on each clock beat decaying to 0; 0 when the clock is stopped. */
  beat: number;
  /** Normalized screen position (0,0 top-left, 1,1 bottom-right) of the performer's hand or body, if the camera is on. */
  hand: { x: number; y: number } | null;
  /**
   * Person mask when the camera is in body mode: confidence in the alpha channel. For a full-screen uv,
   * sample at vec2(maskMirrored ? 1.0 - uv.x : uv.x, 1.0 - uv.y).
   */
  mask: THREE.Texture | null;
  maskMirrored: boolean;
  /** Life color: leaves, chloroplasts, forest tint. */
  colorA: THREE.Color;
  /** Light color: sunlit leaves, cell walls, fireflies. */
  colorB: THREE.Color;
  /** Electric color: pulses, electron sparks, lightning. */
  colorC: THREE.Color;
  /** 0..2 overall brightness. */
  intensity: number;
  /** 0..1 how many trees / chloroplasts / pines. */
  density: number;
  /** 0..1 electricity amount: how many pulses, sparks or bolts a hit produces. */
  charge: number;
  /** 0..1 sun, light shafts, sky brightness. */
  light: number;
  /** 0..1 fireflies / particles amount. */
  life: number;
  /** Lightning Chase: each chase is followed by a turtle and a sloth parading with flags. */
  parade: boolean;
  /** Shiny Cell: 0..1 how often cells are born and die. */
  churn: number;
}

export interface SceneContext {
  renderer: THREE.WebGLRenderer;
  width: number;
  height: number;
}

/** One Forest scene. It owns its THREE.Scene and camera; the app renders it through a bloom pass. */
export interface ForestScene {
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  update(i: ForestInputs): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

export type SceneFactory = (ctx: SceneContext) => ForestScene;
