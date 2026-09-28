// Keep the standalone schematic in the raw MTR/Minecraft orientation.
// app.js currently projects both axes with a minus sign, which rotates the whole city 180°.
// Rather than touching the corridor logic, wrap buildModel and mirror the finished model once.
(() => {
  const originalBuildModel = buildModel;

  buildModel = function(data) {
    const model = originalBuildModel(data);
    const nodes = [...model.nodes.values()];
    if (!nodes.length) return model;

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

    // Existing saved manual edits were made in the old rotated orientation.
    // Ignore them for this corrected orientation unless the user makes new edits afterwards.
    state.edits = {};
    localStorage.removeItem(EDIT_KEY);

    rebuildEdges(model);
    return model;
  };
})();
