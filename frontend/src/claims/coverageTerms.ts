// What a policy covers, in one place: the claim form's "what happened" list, the evidence view and the
// policy terms page all read from here. The ids match CLAIM_EVENTS in backend/src/evidence.ts.
import type { ClaimEvent } from "../api";

export interface CoveredEvent {
  id: ClaimEvent;
  label: string;
  /** One line on what counts. */
  covers: string;
  /** What jurors will want to see in the evidence. */
  evidence: string;
}

export const COVERED_EVENTS: readonly CoveredEvent[] = [
  {
    id: "screen",
    label: "Cracked or broken screen",
    covers: "A screen or back glass cracked or shattered by a drop or knock.",
    evidence: "Photos of the cracked glass with the capture code, and a repair quote.",
  },
  {
    id: "accidental",
    label: "Other accidental damage",
    covers: "Sudden physical damage from an accident: a bent frame, a broken port or camera, a crushed case.",
    evidence: "Photos of the damage, and a few words on how it happened.",
  },
  {
    id: "liquid",
    label: "Liquid damage",
    covers: "Water or another liquid getting into the device and stopping it from working.",
    evidence: "Photos of the device, and a repair shop's note that it is liquid damage if you have one.",
  },
  {
    id: "theft",
    label: "Theft",
    covers: "The device was stolen, by force or from a locked home, car or bag.",
    evidence: "A police report or reference number, and proof the device was yours (the signup photos already show it).",
  },
  {
    id: "breakdown",
    label: "Breakdown after the maker's warranty",
    covers: "A fault that stops the device working once the manufacturer's warranty has ended.",
    evidence: "A repair shop's diagnosis, and the purchase date if you have it.",
  },
];

export const NOT_COVERED: readonly string[] = [
  "Losing the device or leaving it somewhere.",
  "Scratches, dents and wear that don't stop the device working, and battery ageing.",
  "Damage done on purpose, or by repairs from an unauthorised shop.",
  "Anything that happened before the waiting period ended, or while coverage had lapsed.",
  "A device other than the one enrolled at signup.",
  "Faults still covered by the manufacturer's warranty.",
];

export function coveredEvent(id: string | null | undefined): CoveredEvent | null {
  return COVERED_EVENTS.find((event) => event.id === id) ?? null;
}
