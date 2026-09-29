# Folityn Transit — live schematic

A standalone map connected to the running Minecraft Transit Railway server. There is no snapshot fallback and no snapshot-update step.

## Run

Requires Node.js 18+; no npm dependencies.

1. Keep Minecraft and the MTR web map running at `http://127.0.0.1:8888`.
2. Run `npm start` in this repository.
3. Open `http://127.0.0.1:5173`.

The browser requests fresh stations and routes every 15 seconds through the local server. Refresh preserves your view and filters. When MTR becomes unavailable, the last received map stays visible with an explicit stale status; an initial failure shows connection instructions. Reconnection is automatic. Editing temporarily pauses polling.

To use another MTR server, set `MTR_URL` to its full stations-and-routes endpoint before starting the map. For example, in PowerShell:

```powershell
$env:MTR_URL = 'http://127.0.0.1:8888/mtr/api/map/stations-and-routes?dimension=0'
npm start
```

The bridge binds only to loopback. GitHub Pages cannot run Node or reach another person's Minecraft server. The Pages frontend attempts to use your local bridge at port 5173; browser local-network restrictions may block that connection. Opening the local map directly is the supported, reliable live experience. Historical snapshot and userscript files remain in the repository but are neither loaded nor served by the new local app.

## Fixed geometry

`data/schematic.json` is the active infrastructure configuration, separate from live service data:

- **Rynek:** Stare Miasto → Aleje Osamasona → Muzeum Narodowa → Królewska → Stare Miasto, drawn as a compact one-way diamond. The stops are grouped visually under Rynek and retain their own service details. Krakowska is outside the loop.
- **Eastern / Wzgórzyn corridor:** Dworzec Wschodni through Wzgórzyn PKM to Kraszewo/Nowa, straight northeast at 45°.
- **Drzewiec:** Rynek Wielowicki to Drzewiec PKM, straight north–south.
- **Central spine:** Folityn Centralny → Wiadukt Torowy → Rondo Larcho → Most Śródmiejski, straight north–south.
- **Western cross street:** Teatr Miejski to Rondo Rameksi, perpendicular to the central spine.
- **Rogowska:** Rogowska Centrum Miejskie to Szwedzka/Norweska, southeast at 45°, mirrored against Wzgórzyn. Rogowska Centrum Miejskie joins the central spine through one shared junction.
- **Muzea:** Most Śródmiejski to Muzea, a lower parallel southeast diagonal. The separate Larcho/Sucharskiego branch joins at Rynek Chomicki.
- **Jamnikowsko / Polany:** Rogowska Centrum Miejskie → Maniaka → Rondo Moryta-Niejawskiego is straight east–west. From the Rondo, the corridor turns northeast at 45° through Grochowa, Szwedzka Stadion, Jamnikowsko, Jamnikowsko PKM and the Polany stops to Polany/Kolejowa. Witkowskiego stays on the separate southeast Rogowska branch.
- **Line 180:** Wzgórzyn to Solarna uses a continuous intermediate band, with a separate Laskowskiego Wiadukt return branch so it does not jump across the Wzgórzyn/Jamnikowsko area.
- **Polany 710:** The Polany/Kraszewo section is locked to its own continuation of the Jamnikowsko corridor. Lines 715 and 716 keep their live stop patterns while sharing the existing interchange anchors.
- **Line 603:** Wity through WOS and Lipków follows a fixed northbound corridor with hidden bend anchors between the central and northern sections, keeping its long live route continuous.
- **Secondary clean-up:** Międzymiejska–Kwitnącej Wiśni and Wielowicka–Desperaka form an even triangle into Rynek Wielowicki; Folityńska–Stalowa is a simple diagonal; and Most Św. Antoniego–Nowe Miasto I uses a right-angle L bend.

All rendering uses straight segments at 0°, 45° or 90°, never Bezier curves. Surrounding stops use a connected graph layout. A weighted displacement field moves adjacent stops together between fixed anchors, instead of assigning unrelated nearest-segment rotations and scales. Rakoniewicka–Rakoniewicka II continues northwest from Wzgórzyn, with its adjoining branch anchored to preserve direction. Direction variants share physical edges, while station service lists come only from actual MTR stops (passing through a station does not invent a stop). The public numeric route name takes precedence over MTR's directional `number` field.

Unknown/new stops appear from live coordinates. The named corridor anchors remain fixed; add newly commissioned infrastructure anchors to the schematic configuration when they need an explicit corridor lock. This updates layout rules, not network snapshots.

## Interaction

Search stations (or Rynek), filter services, and use City / Full network or the corridor list to change the view. Labels reveal on hover and avoid overlaps. On narrow screens, the menu button opens the sidebar.

Main corridor stops are locked. **Adjust surrounding stops** lets you move other stations on a 20-unit grid. Edits persist in this browser under `folityn-layout-v3`, survive live refresh, and can be exported as JSON. Reset removes only those browser edits.

## Validation

Run `npm test`. Tests cover required corridor relationships, one-way Rynek traversal, skip-stop routing, the Jamnikowsko junction, route grouping, edit persistence, changing live data, upstream failure/timeout, and the server's asset allowlist. GitHub Actions runs the same checks on pushes and pull requests.

Core files: `map-model.js` (pure model and geometry), `app.js` (UI and polling), `server.js` (live bridge), `data/schematic.json` (layout). The former override scripts are not loaded.

