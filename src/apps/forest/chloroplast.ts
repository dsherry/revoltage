import type { SceneFactory } from './types';
import { placeholderScene } from './placeholder';

export const createChloroplast: SceneFactory = (ctx) => placeholderScene(ctx, 'chloroplast');
