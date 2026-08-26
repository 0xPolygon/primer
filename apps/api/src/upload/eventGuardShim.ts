// Inline shim injected as the VERY FIRST child of every artifact's <head>
// (parser-blocking, no src/defer/async), so it runs before ANY
// artifact-authored script. See apps/api/src/upload/inject.ts
// (injectEventGuardShim).
//
// PURPOSE: give the companion's consent gate a way to read a gesture
// event's TRUE dispatch phase that no artifact can forge — defeating both
// prototype-getter poisoning AND per-instance own-property shadowing of
// `eventPhase`.
//
// Background. The consent gate (v1.js) decides "is a trusted gesture's
// dispatch still in progress?" from the event's `eventPhase`. Two facts
// make a naive `event.eventPhase` read forgeable by untrusted artifact JS:
//   1. `Event.prototype.eventPhase` is a CONFIGURABLE prototype getter in
//      Chrome — an artifact could redefine it to always return 2
//      ("AT_TARGET"), so the check always says "in dispatch".
//   2. The SAME event instance is handed to every listener in a dispatch,
//      including the artifact's own — it is NOT private to the companion.
//      So the artifact can `Object.defineProperty(theEvent, 'eventPhase',
//      { get: () => 2 })` on the instance, which a plain property read
//      honors OVER any (even frozen) prototype getter.
// Either forgery lets a hostile artifact launder a setTimeout-deferred
// submit past the in-dispatch check (the exact window requirement 1 closes).
//
// THE FIX: this shim runs FIRST (before any artifact script exists), so it
// captures pristine native primitives and stashes them where v1.js reads
// them and no later code can swap them:
//   - the native `eventPhase` getter function (from the original
//     Event.prototype descriptor);
//   - `Reflect.apply` (to invoke that getter on an instance WITHOUT going
//     through the artifact-poisonable `Function.prototype.call`/`.apply`);
//   - a frozen empty argument list.
// It exposes ONE frozen method, `guard.eventPhase(ev)`, computed as
// `reflectApply(nativeGet, ev, EMPTY)`. Applying the native getter to the
// instance reads the internal, UA-managed [[eventPhase]] slot directly —
// bypassing BOTH a prototype redefine and an instance own-accessor, because
// neither is ever consulted. The guard object is frozen and published as a
// NON-writable, NON-configurable, non-enumerable global, so an artifact
// (which only runs afterwards) can neither replace it, redefine it, nor
// rewrite its method.
//
// SOUNDNESS ARGUMENT (why "captured first, then frozen" holds): every
// primitive the guard depends on — `Object.getOwnPropertyDescriptor`,
// `Reflect.apply`, `Object.defineProperty`, `Object.freeze`, and the native
// `eventPhase` getter — is read/used HERE, during this script's synchronous
// run, which the injection point guarantees precedes all artifact code.
// Nothing hostile exists yet to have poisoned them. The captured references
// are then closed over inside `guard.eventPhase` and the guard is frozen +
// locked, so a later artifact reassigning `Reflect.apply`, redefining the
// prototype getter, or shadowing the instance changes nothing the guard
// uses. (Empirically verified in real Chrome: instance shadow succeeds but
// the captured-native read still returns the true phase; the locked global
// no-ops on assignment and throws on redefine.)
//
// The prototype is ALSO frozen non-configurable below — defense-in-depth
// and it keeps the honest path obvious — but correctness does NOT depend on
// it: `guard.eventPhase` is immune even with the prototype left writable.
//
// Property audit of everything the gate + activation-cluster logic read off
// event objects (reported in the PR): `isTrusted` is per-instance
// [LegacyUnforgeable] (non-configurable; a prototype poison is shadowed by
// the instance own property — safe, no fix); the cluster keys on the
// REGISTERED event-type string (a listener loop variable), never `e.type`
// off the instance; `MessageEvent`'s source/ports/data getters (init
// handshake only; misuse is self-harm to the artifact's own realm) are
// frozen here as behavior-preserving defense-in-depth.
export const EVENT_GUARD_STASH_KEY = '__primerEventGuard__';

export const EVENT_GUARD_SHIM_JS = `(function () {
  function freezeGetter(proto, prop) {
    try {
      var d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.get || d.configurable === false) return;
      Object.defineProperty(proto, prop, {
        get: d.get, set: d.set, enumerable: d.enumerable, configurable: false
      });
    } catch (e) { /* browser refused; guard.eventPhase is the real defense */ }
  }

  // Capture pristine native primitives BEFORE any artifact code exists.
  var reflectApply = Reflect.apply;
  var EMPTY = Object.freeze([]);
  var phaseDesc = Object.getOwnPropertyDescriptor(Event.prototype, 'eventPhase');
  var nativePhaseGet = phaseDesc && phaseDesc.get;

  // The one capability the companion needs: the TRUE dispatch phase of an
  // event, read through the native getter applied to the instance —
  // immune to prototype redefine and instance own-property shadow alike.
  var guard = Object.freeze({
    eventPhase: function (ev) {
      // reflectApply is a captured reference; invoking it directly does not
      // route through Function.prototype.call/apply (artifact-poisonable).
      return reflectApply(nativePhaseGet, ev, EMPTY);
    },
    // Signals whether the native getter was captured. If false, v1.js must
    // fail SAFE (treat as not-in-dispatch) rather than trust a plain read.
    ready: typeof nativePhaseGet === 'function'
  });

  try {
    Object.defineProperty(window, ${JSON.stringify(EVENT_GUARD_STASH_KEY)}, {
      value: guard, writable: false, configurable: false, enumerable: false
    });
  } catch (e) { /* already locked (double-inject); the existing lock stands */ }

  // Defense-in-depth: pin the prototype getters non-configurable too.
  try { freezeGetter(Event.prototype, 'eventPhase'); } catch (e) {}
  if (typeof MessageEvent !== 'undefined') {
    freezeGetter(MessageEvent.prototype, 'source');
    freezeGetter(MessageEvent.prototype, 'ports');
    freezeGetter(MessageEvent.prototype, 'data');
  }
})();`;
