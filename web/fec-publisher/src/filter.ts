// A SUBSCRIBE's filter (draft 18 §5.1.2) against what a track has already sent, as aiomoqt's
// _filter_window: the window is fixed when the subscription is accepted, from the Largest Object that
// SUBSCRIBE_OK reports, and a track sends a subscriber only the Locations inside it.

import { decodeSubscriptionFilter, MessageParam, subscriptionWindow, windowContains,
  type Parameters, type SubscriptionFilter, type SubscriptionWindow } from "@openmoq/transport";

export interface Location { group: bigint; object: bigint }

/** The SUBSCRIPTION_FILTER parameter of a draft-18 SUBSCRIBE; undefined when absent (the whole track). */
export function requestedFilter(params: Map<bigint, unknown[]> | undefined): SubscriptionFilter | undefined {
  const raw = params?.get(MessageParam.SUBSCRIPTION_FILTER)?.[0];
  return raw instanceof Uint8Array ? decodeSubscriptionFilter(raw, 18) : undefined;
}

/** The Locations a subscription takes, given the track's Largest Object when it is accepted. */
export function filterWindow(filter: SubscriptionFilter | undefined, largest: Location | undefined): SubscriptionWindow {
  return subscriptionWindow(filter, largest, 18);
}

export function admits(w: SubscriptionWindow, group: number | bigint, object: number | bigint): boolean {
  return windowContains(w, BigInt(group), BigInt(object));
}

/** SUBSCRIBE_OK's parameters: LARGEST_OBJECT once the track has sent an object. */
export function subscribeOkParams(largest: Location | undefined): Parameters {
  return largest ? new Map([[MessageParam.LARGEST_OBJECT, [{ group: largest.group, object: largest.object }]]]) : new Map();
}

export function describeFilter(f: SubscriptionFilter | undefined): string {
  if (!f) return "none";
  if (f.type === "AbsoluteStart") return `AbsoluteStart ${f.startGroup}.${f.startObject}`;
  if (f.type === "AbsoluteRange") return `AbsoluteRange ${f.startGroup}.${f.startObject}..${f.endGroup}`;
  return f.type;
}

/** The largest Location seen so far on a track. */
export class Largest {
  value: Location | undefined;

  note(group: number | bigint, object: number | bigint): void {
    const g = BigInt(group), o = BigInt(object), v = this.value;
    if (!v || g > v.group || (g === v.group && o > v.object)) this.value = { group: g, object: o };
  }
}
