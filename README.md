# MTR Map Tools

Public map viewer and enhanced journey-planning tools for Minecraft Transit Railway.

## Public GitHub Pages map

The public site loads a saved snapshot from `data/network.json`, so it stays available even when Minecraft is closed.

### Publish/update your network

1. Install `export-network.user.js` in Tampermonkey.
2. Open the MTR web map at `http://localhost:8888/` while Minecraft is running.
3. Click **Export public map** in the bottom-right corner.
4. The userscript downloads `network.json`.
5. Upload that file to this repository as `data/network.json`.
6. GitHub Pages will then show the updated public network.

The static snapshot contains the network structure needed for the public map. Live data such as player positions and current departures only exists while the MTR server is running and is not stored in the public snapshot by default.

## GitHub Pages

In repository **Settings → Pages**, publish from the `main` branch and `/ (root)` folder.

