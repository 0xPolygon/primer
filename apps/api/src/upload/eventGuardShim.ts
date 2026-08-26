// Inline shim injected as the VERY FIRST child of every artifact's <head>
// (parser-blocking, no src/defer/async), so it runs before ANY
// artifact-authored script. See apps/api/src/upload/inject.ts
// (injectEventGuardShim).
//
// Why: the consent gate in the companion (v1.js) decides "is a trusted
// gesture's dispatch still in progress?" by reading `event.eventPhase` off
// the stored trusted gesture event. `Event.prototype.eventPhase` is a
// CONFIGURABLE prototype getter in Chrome (empirically verified), and
// artifact scripts run before the deferred companion — so a hostile
// artifact could `Object.defineProperty(Event.prototype, 'eventPhase',
// { get: () => 2 })` and make the getter always report "in dispatch",
// collapsing the in-dispatch check to "was there ever a genuine gesture"
// and letting a setTimeout-deferred submit ride a real click (the exact
// deferral-laundering window requirement 1 exists to close). This shim
// captures the native getter and re-defines the property NON-CONFIGURABLE
// (native getter intact), so the artifact's later redefine throws /
// delete no-ops and the gate reads the true, live phase.
//
// Scope of the audit behind this shim (report in the PR): the consent
// gate + activation-cluster logic read only `isTrusted` (per-instance,
// [LegacyUnforgeable], non-configurable — a prototype poison is shadowed
// by the instance own property; verified, no fix needed) and `eventPhase`
// (frozen here). The cluster keys on the REGISTERED event-type string (a
// listener loop variable), never `e.type` off the instance. MessageEvent's
// `source`/`ports`/`data` getters (used only by the init handshake, whose
// misuse is self-harm to the artifact's own realm) are configurable too;
// frozen here as behavior-preserving defense-in-depth.
//
// Each freeze is independently try/caught: a browser that refuses one must
// not abort the others, and the artifact is never left worse off than
// before this shim existed. Freezing keeps the native getter, so nothing
// legitimate changes.
export const EVENT_GUARD_SHIM_JS = `(function () {
  function freezeGetter(proto, prop) {
    try {
      var d = Object.getOwnPropertyDescriptor(proto, prop);
      // Only act on a configurable accessor we can pin. If it's already
      // non-configurable (e.g. an instance-unforgeable prop absent from the
      // prototype), there is nothing to poison here.
      if (!d || !d.get || d.configurable === false) return;
      Object.defineProperty(proto, prop, {
        get: d.get,
        set: d.set,
        enumerable: d.enumerable,
        configurable: false
      });
    } catch (e) {
      // Browser refused; the gate still re-checks isTrusted (unforgeable),
      // which bounds the blast radius regardless.
    }
  }
  try { freezeGetter(Event.prototype, 'eventPhase'); } catch (e) {}
  if (typeof MessageEvent !== 'undefined') {
    freezeGetter(MessageEvent.prototype, 'source');
    freezeGetter(MessageEvent.prototype, 'ports');
    freezeGetter(MessageEvent.prototype, 'data');
  }
})();`;
