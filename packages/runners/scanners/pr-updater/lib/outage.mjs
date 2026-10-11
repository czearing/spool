/**
 * What to say when a poll cycle dies, and what to keep on screen while it is dead.
 *
 * A failing cycle used to overwrite the status file with nothing but an error string, so the
 * dashboard lost every pull request it had been watching and looked idle rather than broken.
 * Monitoring was down for over an hour before anyone noticed. The rule here is that an outage
 * must be additive: keep the last known state visible, and say plainly that it is stale.
 */

/** Signs that the request never reached the service because the credential was refused. */
const AUTH_MARKERS = [
  "token was not accepted",
  "rejected the token",
  "requires user authentication",
  "TF400813",
  "401",
  "403",
];

/** The Azure DevOps resource id, so the remedy can be copied straight into a shell. */
const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

/**
 * Name the outage and, where possible, the one command that ends it.
 *
 * Authentication is separated from every other failure because it is the only one the operator
 * can fix in ten seconds, and because it takes down every runner on the machine at once rather
 * than one pull request.
 */
export function classifyOutage(error) {
  const text = `${error?.message || ""} ${error?.stack || ""}`;
  const isAuth = AUTH_MARKERS.some((marker) => text.includes(marker));
  if (isAuth) {
    return {
      kind: "auth",
      headline: "Azure DevOps authentication has expired, so nothing is being monitored",
      remedy: `az login --scope ${ADO_RESOURCE}/.default`,
    };
  }
  return {
    kind: "error",
    headline: "The last poll cycle failed, so the state below may be stale",
    remedy: "",
  };
}

/**
 * The status to write when a cycle fails.
 *
 * Everything the previous pass established is preserved so the operator can still see which pull
 * requests were being watched; only the freshness and the alarm are new.
 */
export function blockedStatus(previous, error, extra = {}) {
  const outage = classifyOutage(error);
  return {
    ...(previous || {}),
    ...extra,
    blocked: {
      ...outage,
      error: String(error?.message || error).split("\n")[0],
      since: previous?.blocked?.since || new Date().toISOString(),
      cycles: (previous?.blocked?.cycles || 0) + 1,
    },
    staleSince: previous?.blocked?.since || previous?.lastScan || null,
  };
}
