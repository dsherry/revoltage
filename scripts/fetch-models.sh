#!/usr/bin/env bash
# Copies the MediaPipe wasm runtime and downloads the vision models into public/,
# so the app works offline at the venue. Safe to re-run; existing models are kept.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p public/mediapipe/wasm public/models
cp node_modules/@mediapipe/tasks-vision/wasm/* public/mediapipe/wasm/

B=https://storage.googleapis.com/mediapipe-models
for m in \
  pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task \
  pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task \
  gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task \
  image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite; do
  f="public/models/$(basename "$m")"
  if [ -s "$f" ]; then echo "have  $f"; continue; fi
  echo "fetch $f"
  curl -fsSL "$B/$m" -o "$f"
done

ls -lh public/models public/mediapipe/wasm
