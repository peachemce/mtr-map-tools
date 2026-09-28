// Remove ghost station markers that belong only to non-rendered route variants.
(() => {
  const baseDrawNode = drawNode;

  function hasVisibleRenderedEdge(nodeKey) {
    const model = state.model;
    if (!model) return false;
    for (const edge of model.edges.values()) {
      if (edge.a !== nodeKey && edge.b !== nodeKey) continue;
      for (const serviceKey of edge.services) {
        const service = model.services.find(s => s.key === serviceKey);
        if (service && visibleService(service)) return true;
      }
    }
    return false;
  }

  drawNode = function drawNodeVisibleOnly(n) {
    // A stop that exists only in an unused directional variant must not float on the map.
    if (!hasVisibleRenderedEdge(n.key)) return;
    return baseDrawNode(n);
  };

  // Re-render if the network already loaded before this patch executed.
  if (state.model) render();
})();
