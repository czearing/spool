export function readFlights() {
  return { runners: process.env.SPOOL_ENABLE_RUNNERS === "1" };
}
