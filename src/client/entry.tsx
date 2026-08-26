import { apply as applyCrew, inject as crewInject } from './index';

export const inject = crewInject;

// Keep a single settings slot. Adaptive routing and activation boundaries live
// inside the main DSH Crew operations console instead of creating sidebar noise.
export function apply(ctx: any): void {
  applyCrew(ctx);
}
