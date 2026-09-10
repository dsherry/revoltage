// Output window: a canvas the engine (in the control window) draws into every frame.
type EngineRef = Pick<NonNullable<Window['__revoltage']>, 'output' | 'keyboard'>;

const hint = document.getElementById('hint') as HTMLDivElement;
const engineRef = (): EngineRef | undefined => (window.opener as Window | null)?.__revoltage;

function attach(): void {
  engineRef()?.output.attach(window);
}

function goFullscreen(): void {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
}

attach();
// Re-attach after the control window reloads: the opener reference survives, the engine is new.
setInterval(attach, 1000);

addEventListener('click', goFullscreen);
addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenElement) void document.exitFullscreen();
    else goFullscreen();
    return;
  }
  engineRef()?.keyboard.handle(e);
});
// The control window's Fullscreen button delegates fullscreen capability with this message.
addEventListener('message', (e) => {
  if (e.origin === location.origin && (e.data as { type?: string } | null)?.type === 'fullscreen') goFullscreen();
});
if (!window.opener) hint.textContent = 'Open this window from the Revoltage control window (press O there).';
