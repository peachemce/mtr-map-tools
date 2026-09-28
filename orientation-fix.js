// Keep the standalone schematic in the raw MTR/Minecraft orientation.
// app.js currently projects both axes with a minus sign, which rotates the whole city 180°.
// Rather than touching the corridor logic, mirror the finished model in data space.
(() => {
  function flipModel(model) {
    const nodes = [...model.nodes.values()];
    if (!nodes.length || model.__orientationFixed) return model;

    const minX = Math.min(...nodes.map(n => n.x));
    const maxX = Math.max(...nodes.map(n => n.x));
    const minY = Math.min(...nodes.map(n => n.y));
    const maxY = Math.max(...nodes.map(n => n.y));
    const cx2 = minX + maxX;
    const cy2 = minY + maxY;

    for (const n of nodes) {
      n.x = cx2 - n.x;
      n.y = cy2 - n.y;
      if (n.geo) {
        n.geo.x = cx2 - n.geo.x;
        n.geo.y = cy2 - n.geo.y;
      }
    }

    model.__orientationFixed = true;
    rebuildEdges(model);
    return model;
  }

  const originalBuildModel = buildModel;
  buildModel = function(data) {
    return flipModel(originalBuildModel(data));
  };

  // Existing saved edits were made in the old rotated orientation.
  state.edits = {};
  localStorage.removeItem(EDIT_KEY);

  // Race-safe: if app.js already finished loading the network, fix that model immediately too.
  if (state.model) {
    flipModel(state.model);
    render();
    fit();
  }
})();
