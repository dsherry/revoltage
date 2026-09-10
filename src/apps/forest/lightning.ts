import type { SceneFactory } from './types';
import { placeholderScene } from './placeholder';

export const createLightning: SceneFactory = (ctx) => placeholderScene(ctx, 'lightning');
