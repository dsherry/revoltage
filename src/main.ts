import { mount } from 'svelte';
import App from './ui/App.svelte';
import { engine } from './engine/engine';
import { installErrorHandlers } from './engine/log';

installErrorHandlers(window, 'control');
window.__revoltage = engine;
engine.boot();
mount(App, { target: document.getElementById('app')! });
