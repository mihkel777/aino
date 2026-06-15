// Single hardcoded restaurant for the weekend demo.
// In the real product this comes from each business's stored configuration.

export const restaurant = {
  name: "Restoran Kalevipoeg",
  capacity: 24, // total seats bookable per time slot
  maxPartySize: 8, // larger groups -> redirect to web form
  // Opening hours per weekday (0 = Sunday ... 6 = Saturday). null = closed.
  hours: {
    0: { open: "12:00", close: "21:00" },
    1: null, // Monday closed
    2: { open: "12:00", close: "22:00" },
    3: { open: "12:00", close: "22:00" },
    4: { open: "12:00", close: "22:00" },
    5: { open: "12:00", close: "23:00" },
    6: { open: "12:00", close: "23:00" },
  },
  slotMinutes: 30, // booking granularity
};

export function openingHoursFor(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay();
  return restaurant.hours[day] || null;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function slotIsWithinHours(dateStr, time) {
  const hrs = openingHoursFor(dateStr);
  if (!hrs) return false;
  const t = toMinutes(time);
  // last seating must be before close
  return t >= toMinutes(hrs.open) && t <= toMinutes(hrs.close) - restaurant.slotMinutes;
}
