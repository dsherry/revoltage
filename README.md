# revoltage
Platform for audiovisual experiments at Re:Voltage Sept 2026

A browser-only platform for small audiovisual "apps" that react to audio, MIDI,
cameras and Arduino sensors, rendered to a projector. Chrome on macOS only.
Design and decisions: [docs/SPEC.md](docs/SPEC.md). Sensor wiring: [docs/ARDUINO.md](docs/ARDUINO.md).

## Run

```sh
npm install
npm run models   # once: copies the MediaPipe runtime and downloads vision models into public/
npm run dev      # http://localhost:5173 with hot reload
npm run show     # production build on the same port, for the performance
```

1. Open http://localhost:5173 in Chrome and click **Start** (allow microphone, MIDI and camera).
2. Press **O** to open the output window, drag it to the projector, then click inside it (or press **F**) for fullscreen.

## Keys (control window)

| Key | Action |
|---|---|
| 1–8 | Load setlist slot |
| ← / → | Previous / next setlist slot (also the APC ◀ ▶ buttons) |
| B | Blackout |
| Shift+P | Panic (mute app audio, all notes off) |
| Space / T | Clock play-stop / tap tempo |
| O | Open or focus the output window |

## Writing an app

Create `src/apps/<name>/index.ts` with a default export from `defineApp` (see
`src/apps/test-pattern` and `src/apps/pulse`). The app API lives in `src/sdk/`.
Apps hot-reload while you edit them; devices stay open.
