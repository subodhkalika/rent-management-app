import { unitTypeHasBedrooms, unitTypeHasBathrooms, unitTypeLabels, type Unit } from '@rms/contract';

/**
 * "2 bd / 1 ba" for a flat or a house — the only two types `unitTypeHasBedrooms` /
 * `unitTypeHasBathrooms` say have either. `null` for everything else (a shutter, a
 * single room, a garage, an office), so a caller that already shows the unit's
 * type elsewhere can render its own fallback rather than this printing
 * "— bd / — ba" or, worse, "null bd / null ba".
 */
export function unitRoomsLine(unit: Pick<Unit, 'type' | 'bedrooms' | 'bathrooms'>): string | null {
  const parts: string[] = [];
  if (unitTypeHasBedrooms(unit.type) && unit.bedrooms != null) parts.push(`${unit.bedrooms} bd`);
  if (unitTypeHasBathrooms(unit.type) && unit.bathrooms != null) parts.push(`${unit.bathrooms} ba`);
  return parts.length > 0 ? parts.join(' / ') : null;
}

/**
 * Same as `unitRoomsLine`, but falls back to the unit type's own label
 * ("Shutter / shop") when there is no room count to show — for a caller that has
 * nowhere else on screen to say what kind of unit this is. Shared by every place
 * a unit gets summarised (the units table, the lease wizard's unit picker) so
 * they never disagree about which types have rooms.
 */
export function unitSummaryLine(unit: Pick<Unit, 'type' | 'bedrooms' | 'bathrooms'>): string {
  return unitRoomsLine(unit) ?? unitTypeLabels[unit.type];
}
