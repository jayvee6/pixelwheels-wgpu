// WaypointStore — AI navigation waypoints indexed by lap distance (port of map/WaypointStore.java).
// Built from the single Waypoints polyline; each point's lapDistance comes from the LapPositionTable.
import type { LapPositionTable } from "./lap.ts";
import type { TrackData } from "./track.ts";

interface WaypointInfo { x: number; y: number; lapDistance: number; } // x,y in world PIXELS

export class WaypointStore {
  private pts: WaypointInfo[] = [];

  constructor(track: TrackData, table: LapPositionTable) {
    const wp = track.objects.Waypoints?.[0];
    if (!wp?.points) return;
    for (const [px, py] of wp.points) {
      const ax = wp.x + px, ay = wp.y + py;
      const pos = table.get(ax, ay);
      this.pts.push({ x: ax, y: ay, lapDistance: pos ? pos.lapDistance : 0 });
    }
  }

  get count(): number { return this.pts.length; }
  getWaypoint(i: number): { x: number; y: number } { return this.pts[i]; }
  getPreviousIndex(i: number): number { return (i > 0 ? i : this.pts.length) - 1; }
  getNextIndex(i: number): number { return (i + 1) % this.pts.length; }

  /** First waypoint whose lapDistance is ahead of the given lap distance (wraps to 0). */
  getWaypointIndex(lapDistance: number): number {
    for (let i = 0; i < this.pts.length; i++) {
      if (lapDistance < this.pts[i].lapDistance) return i;
    }
    return 0;
  }
}
