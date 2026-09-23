// graphology-layout-forceatlas2 ships declarations for its index and its worker supervisor only.
// layout.ts drives the package's worker function itself (its import comment says why), so these two
// internal modules are declared here — read from the 0.10.1 source that package-lock.json pins.
declare module 'graphology-layout-forceatlas2/webworker.js' {
  /** The worker's whole body. createWorker stringifies it into a Blob URL, so it must stay
   *  self-contained. Protocol: receives { settings, nodes, edges? } (edges on the first message
   *  only), runs one iteration, replies { nodes } with the buffer transferred. */
  const worker: () => void;
  export default worker;
}

declare module 'graphology-layout-forceatlas2/helpers.js' {
  export function createWorker(fn: () => void): Worker;
  /** PPN (10) floats per node in forEachNode order — x, y, dx, dy, old dx, old dy, mass,
   *  convergence, size, fixed — and 3 per edge: source offset, target offset, weight. */
  export function graphToByteArrays(
    graph: object, getEdgeWeight: () => number,
  ): { nodes: Float32Array; edges: Float32Array };
}
