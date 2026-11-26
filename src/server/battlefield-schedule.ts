const hour = 3600_000;
const day = 24 * hour;
const vietnamOffset = 7 * hour;
export const battlefieldMatchMs = 30 * 60_000;
export const battlefieldRegistrationMs = 10 * 60_000;

/** Vietnam uses UTC+7 year-round. Slot keys are UTC timestamps. */
export function battlefieldSchedule(now: number) {
  const local = now + vietnamOffset;
  const midnight = Math.floor(local / day) * day - vietnamOffset;
  const localHour = Math.floor((now - midnight) / hour);
  const current = midnight + localHour * hour;
  const live = localHour >= 8 && now < current + battlefieldMatchMs ? current : null;
  const next = localHour < 8 ? midnight + 8 * hour
    : localHour < 23 ? current + hour : midnight + day + 8 * hour;
  return { live, next, registration: now >= next - battlefieldRegistrationMs };
}
