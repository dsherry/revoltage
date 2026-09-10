import type { SceneFactory } from './types';
import { placeholderScene } from './placeholder';

export const createCanopy: SceneFactory = (ctx) => placeholderScene(ctx, 'canopy');
