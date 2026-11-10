# Tonix-Lab-LIVE

A lightweight live-streaming studio for Windows, laid out like a broadcast control room: Program and Preview monitors, a multiview wall of your scenes, a switcher desk with CUT and TAKE, an audio desk, and one-button Go Live.

## Install

1. Open this repo's **Releases** page and download the newest `Tonix-Lab-LIVE-Setup-x.y.z.exe`.
2. Run it. If Windows SmartScreen appears, click **More info → Run anyway** (the installer is not code-signed yet).
3. Open **Tonix-Lab-LIVE** from the Start menu.

The first launch builds a starter show: Starting Soon, Gameplay, Screen, Camera and Be Right Back.

## Using the control room

- **Preview a scene:** click its tile in the multiview, its PVW button, or press keys **1–9**.
- **Put it on air:** press **TAKE** (uses the selected transition) or **CUT** (instant). Enter = TAKE, C = CUT.
- **Build a scene:** whatever is in Preview is the "Next shot". Use **+ Add source** for game capture, camera or HDMI capture card, screen, window, mic, image, text or a color background. **Fit** scales a source to fill the screen.
- **Go live:** click **Edit** in Output, pick the platform, paste your stream key, then **Go live**.

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
2. Custom scenes — move/resize sources, overlays, lower thirds
3. Phones — studio account, phones as cameras, phone remote
4. Multistream — sign in to YouTube/Facebook/Twitch, one Go Live to all

## Licenses

Tonix-Lab-LIVE's own code is MIT. The bundled OBS Studio engine is GPL-2.0; its source code is at https://github.com/obsproject/obs-studio.
