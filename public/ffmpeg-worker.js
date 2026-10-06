/* Same-origin module worker for @ffmpeg/ffmpeg 0.12.
   Chrome will not start the CDN worker.js directly (cross-origin module worker).
   This file is served from our origin and imports that worker module. */
import 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/worker.js';
