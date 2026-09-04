import { applyQuick } from './quick-panel';

export const inject = ['slots', 'locale'];

// Quick-controls entry for the official 3080 surface: master switch,
// flash/pro model priority, vision/imagegen toggles only. Never ships the
// full control-plane code.
export function apply(ctx: any): void {
  applyQuick(ctx);
}
