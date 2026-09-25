# Folityn Transit Map

Standalone schematic map for the Folityn Minecraft Transit Railway network.

The map does **not** modify or inject into the MTR dashboard. MTR is used only as the data source. The renderer has its own physical corridor graph, so route directions and one-way stops cannot invent new geometry.

## Run locally

Requirements: Node.js 18 or newer.

```bash
npm start
```

Then open:

```text
http://127.0.0.1:5173
```

Keep Minecraft/MTR running at `http://127.0.0.1:8888` for live network data. If MTR is unavailable, the server automatically falls back to `data/network.json`.

No npm packages are required.

## How the schematic works

The physical map is configured in `data/schematic.json`:

- `hubs`: fixed major nodes such as **RYNEK**, **Folityn Centralny**, and **Wity**.
- `nodes`: fixed station positions.
- `corridors`: ordered physical infrastructure. Routes are routed across these corridors rather than drawing straight lines between served stops.
- `aliases`: groups multiple MTR stations into one schematic hub. For example, Królewska, Stare Miasto, Aleje Osamasona and Muzeum Narodowa are grouped as **RYNEK**.

This means a route that skips a stop still uses the same road/track. The skipped stop simply has no service marker for that route.

## Layout editor

Click **Edit layout** in the sidebar and drag stations/hubs. Edits are stored in browser local storage and do not change `data/schematic.json` automatically.

- **Export edits** downloads your local coordinate overrides as JSON.
- **Reset edits** returns to the committed schematic.

Once a layout is satisfactory, the coordinates can be copied into `data/schematic.json`.

## Filters

The standalone map separates:

- Trams: numeric lines 1–20
- Buses: numeric lines 100+
- Normal rail
- High-speed / IC

Opposite-direction variants of the same numbered tram/bus service are grouped into one service color on the shared infrastructure.

## Public snapshot

`data/network.json` is still usable as a public/offline snapshot. GitHub Pages can render that snapshot, but live MTR data requires the local `server.js` proxy.
