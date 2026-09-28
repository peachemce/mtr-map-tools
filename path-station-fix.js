// Hide ghost/orphan station markers that belong only to non-rendered route variants.
// A stop is visible only when at least one currently visible service has it in svc.path.
(() => {
  drawNode = function(n) {
    const active = state.model.services.filter(s =>
      s && visibleService(s) && Array.isArray(s.path) && s.path.includes(n.key)
    );
    if (!active.length) return;

    const g = svgEl('g', { class: `station-group ${n.kind}`, 'data-key': n.key });
    if (state.edit) g.classList.add('editable');

    let shape;
    if (n.kind === 'major-hub') shape = svgEl('circle', { cx: n.x, cy: n.y, r: 13, class: 'hub major-hub' });
    else if (n.kind === 'hub') shape = svgEl('circle', { cx: n.x, cy: n.y, r: 9, class: 'hub' });
    else shape = svgEl('circle', { cx: n.x, cy: n.y, r: 4.5, class: 'station-dot' });

    g.append(shape);
    g.onclick = ev => { ev.stopPropagation(); showNode(n, ev); };
    if (state.edit) g.onpointerdown = ev => startNodeDrag(ev, n);
    stationsLayer.append(g);

    const important = n.kind !== 'normal' || active.length >= 3 || n.lock;
    const t = svgEl('text', {
      x: n.x + 8,
      y: n.y - 8,
      class: `station-label${important ? ' important' : ''}`,
      'data-label-for': n.key,
    });
    t.textContent = n.label;
    labelsLayer.append(t);
  };

  // If the map is already present, repaint immediately with the corrected stop visibility.
  if (state.model) render();
})();
