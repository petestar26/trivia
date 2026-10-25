import * as THREE from 'three';
import collar from './continuous-shirt-collar-source.json';

const key = (x: number, y: number, z: number) =>
  [x, y, z].map((value) => Math.round(value * 1e7)).join(',');
const targets = new Map(
  collar.surfaceControls.map((control) => [
    key(...(control.sourcePosition as [number, number, number])),
    control,
  ])
);

/** Construction-time evaluation of the editable neutral collar control mesh.
 * Source topology, UVs, binding and vertex IDs remain; no posed fairing is added.
 * Author once before LOD generation. LODs inherit that authored source marker. */
export function authorContinuousShirtCollar(source: THREE.BufferGeometry, positions: number[]) {
  const input = source.getAttribute('position');
  if (positions.length !== input.count * 3) throw new Error('Invalid collar authoring positions');
  const inherited = source.userData.authoredCollarSource;
  if (inherited?.applied)
    return { ...inherited, transferredToLod: Boolean(source.userData.continuousLod) };
  const report = {
    source: 'continuous-shirt-collar-source.json',
    sourceAssetSHA256: collar.source.sha256,
    originalSourceVerticesRetained: true,
    originalUVsAndBindingRetained: true,
    maximumDisplacementMetres: 0,
    applied: false,
    transferredToLod: false,
    records: [] as Array<{ vertex: number; sourceVertex: number; row: number; column: number }>,
  };
  // Unknown optional input retains the existing complete garment. Never apply
  // source-index offsets to an independently decimated or differently bound mesh.
  if (
    input.count !== collar.source.sourceVertices ||
    collar.surfaceControls.some(
      (control) =>
        Math.hypot(
          input.getX(control.sourceVertex) - control.sourcePosition[0],
          input.getY(control.sourceVertex) - control.sourcePosition[1],
          input.getZ(control.sourceVertex) - control.sourcePosition[2]
        ) > 2e-7
    )
  )
    return report;
  for (let id = 0; id < input.count; id++) {
    const control = targets.get(key(input.getX(id), input.getY(id), input.getZ(id)));
    if (!control) continue;
    const displacement = Math.hypot(
      ...control.position.map((v, axis) => v - control.sourcePosition[axis])
    );
    if (displacement > collar.maximumAuthoredDisplacementMetres)
      throw new Error('Authored collar displacement exceeds its source bound');
    for (let axis = 0; axis < 3; axis++) positions[id * 3 + axis] = control.position[axis];
    report.maximumDisplacementMetres = Math.max(report.maximumDisplacementMetres, displacement);
    report.records.push({
      vertex: id,
      sourceVertex: control.sourceVertex,
      row: control.row,
      column: control.column,
    });
  }
  report.applied = true;
  return report;
}

/** Private editable-source derivative shared by this actor's high/low construction.
 * Caller disposes it after the derived shirt wrappers/correctives are released. */
export function createAuthoredContinuousShirtSource(source: THREE.BufferGeometry) {
  const geometry = source.clone();
  const positions = Array.from(source.getAttribute('position').array);
  const report = authorContinuousShirtCollar(source, positions);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.userData.authoredCollarSource = report;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
