// Helpers shared by fleet.mjs and the dashboard.
export function isReject(v) {
  return ['rework', 'rework-needed', 'rejected', 'fail'].includes(String(v));
}
export function isAccept(v) {
  return ['accept', 'verified', 'pass'].includes(String(v));
}
