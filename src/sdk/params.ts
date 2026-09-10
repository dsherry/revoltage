import type { Vec2, Vec3, Zone } from './types';

interface ParamBase {
  /** Shown in the settings page; defaults to the param's key. */
  label?: string;
  /** Tooltip / help text in the settings page. */
  description: string;
  /** Params with the same group are shown in one folder. */
  group?: string;
}

export interface ToggleParam extends ParamBase { type: 'toggle'; default: boolean }
export interface NumberParam extends ParamBase { type: 'number'; default: number; min?: number; max?: number; step?: number }
export interface SliderParam extends ParamBase { type: 'slider'; default: number; min: number; max: number; step?: number }
export interface SelectParam extends ParamBase { type: 'select'; options: readonly string[]; default: string }
export interface ColorParam extends ParamBase { type: 'color'; default: string }
export interface TriggerParam extends ParamBase { type: 'trigger' }
export interface XYParam extends ParamBase { type: 'xy'; default: Vec2; min?: number; max?: number }
export interface Vec3Param extends ParamBase { type: 'vec3'; default: Vec3; min?: number; max?: number }
export type InputKind = 'camera' | 'audioIn' | 'midiIn' | 'midiOut' | 'sensor';
export interface InputParam extends ParamBase { type: 'input'; kind: InputKind; default?: string }
/** `camera` is the key of an `input` param of kind camera, or a device name. */
export interface ZonesParam extends ParamBase { type: 'zones'; camera: string; default?: readonly Zone[] }

export type ParamDef =
  | ToggleParam | NumberParam | SliderParam | SelectParam | ColorParam
  | TriggerParam | XYParam | Vec3Param | InputParam | ZonesParam;

export type ParamSchema = { readonly [key: string]: ParamDef };

export type ParamValue<P> =
  P extends { type: 'toggle' } ? boolean :
  P extends { type: 'select'; options: readonly (infer O)[] } ? O :
  P extends { type: 'color' } ? string :
  P extends { type: 'trigger' } ? number :
  P extends { type: 'xy' } ? Vec2 :
  P extends { type: 'vec3' } ? Vec3 :
  P extends { type: 'input' } ? string :
  P extends { type: 'zones' } ? Zone[] :
  number;

export type ParamValues<S extends ParamSchema> = { readonly [K in keyof S]: ParamValue<S[K]> };

export interface ParamControls<S extends ParamSchema> {
  /** Set a value (clamped/coerced); the settings page and presets follow. */
  set<K extends keyof S & string>(key: K, value: ParamValue<S[K]>): void;
  /** Called whenever the value changes (from the UI, a preset, or `set`). */
  on<K extends keyof S & string>(key: K, cb: (value: ParamValue<S[K]>) => void): () => void;
  /** Fire a trigger param. */
  fire(key: keyof S & string): void;
}

/** `ctx.params`: read values directly (`ctx.params.speed`), write with `ctx.params.set(...)`. */
export type Params<S extends ParamSchema> = ParamValues<S> & ParamControls<S>;

export const RESERVED_PARAM_NAMES: readonly string[] = ['set', 'on', 'fire'];

export function defineParams<const S extends ParamSchema>(schema: S): S {
  return schema;
}
