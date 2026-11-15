import type { MultiPolygon, Polygon } from 'polygon-clipping'

declare module 'polygon-clipping' {
  type Geom = Polygon | MultiPolygon
  const polygonClipping: {
    intersection(geom: Geom, ...geoms: Geom[]): MultiPolygon
  }
  export default polygonClipping
}
