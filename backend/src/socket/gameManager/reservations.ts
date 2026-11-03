import { PHYSICAL_COLORS, type PhysicalColor } from '../../shared/types.js';
import { sessions } from './state.js';
const online = new Set<PhysicalColor>();
const listeners = new Set<() => void>();
export function onAvailabilityChange(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function availabilityChanged() { for (const fn of listeners) fn(); }
export function setDeviceOnline(color: PhysicalColor, connected: boolean) {
  if (connected) online.add(color); else online.delete(color);
  availabilityChanged();
}
export function getBuzzerAvailability(roomCode: string) {
  const owners = [...sessions.values()].flatMap(s => s.players.filter(p => p.physicalColor).map(p => ({ room: s.roomCode, color: p.physicalColor })));
  return PHYSICAL_COLORS.map(color => ({ color, online: online.has(color), reserved: owners.some(o => o.room !== roomCode || o.color === color) }));
}
// Validation and claim mutation must run synchronously, without yielding.
export function validatePhysicalClaim(roomCode: string, color: unknown): string | undefined {
  if (color === undefined || color === null) return;
  const status = getBuzzerAvailability(roomCode).find(s => s.color === color);
  if (!status) return 'Unknown physical buzzer color';
  if (!status.online) return 'That physical buzzer is offline. Choose again.';
  if (status.reserved) return 'That color is reserved or the physical set is in use by another game. Choose again.';
}
export function releaseRoomReservations(roomCode: string) {
  for (const player of sessions.get(roomCode)?.players ?? []) delete player.physicalColor;
  availabilityChanged();
}
