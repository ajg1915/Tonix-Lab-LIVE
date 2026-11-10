# Tonix-Lab-LIVE

A lightweight OBS-style live-streaming studio for Windows: the familiar canvas with Scenes, Sources, Audio Mixer, Scene Transitions and Controls docks, built to stay light on your CPU and graphics card.

## Install

1. Open this repo's **Releases** page and download the newest `Tonix-Lab-LIVE-Setup-x.y.z.exe`.
2. Run it. If Windows SmartScreen appears, click **More info → Run anyway** (the installer is not code-signed yet).
3. Open **Tonix-Lab-LIVE** from the Start menu.

The first launch builds a starter show: Starting Soon, Gameplay, Screen, Camera and Be Right Back.

## Using the studio

- **Scenes dock:** click a scene to switch to it, + to add, − to remove, double-click to rename.
- **Sources dock:** + adds a source (Browser/HTML overlay, Image, Text, Color, Game Capture, Display Capture, Window Capture, Video Capture Device for webcams and HDMI capture cards, Media, audio). The eye shows/hides, the lock stops it moving, ▲▼ change the layer order, double-click opens Properties.
- **Canvas:** click a source to select it, drag to move, pull the red handles to resize (Shift = free resize, Alt = no snapping). Arrow keys nudge, Delete removes. Right-click for Fit/Stretch/Center/Reset transform and layer order.
- **Studio Mode:** edit the Preview while Program stays live, then press Transition or Cut.
- **Start Streaming:** set your service and stream key in Settings › Stream first.

## Light on your PC

- The video is encoded on your graphics chip (NVIDIA NVENC, AMD AMF or Intel Quick Sync), picked automatically. CPU encoding is a fallback.
- Game capture hooks into the game directly instead of recording the whole screen.
- **Performance mode** slows the preview pictures in the app. **Settings → Stream quality → Performance** streams 720p30 for slower PCs and graphics cards.
- The LAG chip turns amber or red if the PC can't keep up, and a tip appears.

## How it's built

Electron interface + the OBS engine (libobs) running hidden in the background, controlled over a local password-protected websocket. The engine keeps its own settings in the app's data folder, so it never touches a normal OBS install on the same PC.

GitHub Actions builds the installer on every push to `main` and publishes it to Releases.

## Roadmap

1. ✅ Core studio — capture, hardware encoding, go live to one platform
2. ✅ OBS-style editor — move/resize sources, Browser/HTML and image overlays
3. Phones — studio account, phones as cameras, phone remote
4. Multistream — sign in to YouTube/Facebook/Twitch, one Go Live to all

## Licenses

Tonix-Lab-LIVE's own code is MIT. The bundled OBS Studio engine is GPL-2.0; its source code is at https://github.com/obsproject/obs-studio.
