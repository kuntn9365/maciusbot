// Runs in the page's MAIN world at document_start, before any page script.
// Replaces Date (and friends) with a clock shifted to the configured time.
// Config is read synchronously from localStorage (mirrored there by bridge.js
// and the popup) so the very first Date.now() the page calls is already fake.
(() => {
  'use strict';

  const KEY = '__countdown_peek__';
  const EVT = '__countdown_peek_update__';
  const GUARD = Symbol.for(EVT);

  if (window[GUARD]) return;
  Object.defineProperty(window, GUARD, { value: true });

  const NativeDate = Date;
  const nativeNow = NativeDate.now;

  let enabled = false;
  let freeze = false;
  let startReal = 0;
  let startFake = 0;
  let installed = false;

  function now() {
    if (!enabled) return nativeNow();
    return freeze ? startFake : startFake + (nativeNow() - startReal);
  }

  function apply(cfg) {
    if (!cfg || !cfg.enabled) {
      enabled = false;
      return;
    }
    const real = nativeNow();
    startReal = real;
    startFake = cfg.mode === 'offset' ? real + Number(cfg.offset || 0) : Number(cfg.target);
    freeze = !!cfg.freeze;
    enabled = Number.isFinite(startFake);
    if (enabled) install();
  }

  function install() {
    if (installed) return;
    installed = true;

    // Keep patched functions looking native to Function.prototype.toString.
    const fnToString = Function.prototype.toString;
    const disguised = new WeakMap();
    const disguise = (fake, real) => {
      disguised.set(fake, fnToString.call(real));
      return fake;
    };
    const toString = {
      toString() {
        return disguised.has(this) ? disguised.get(this) : fnToString.call(this);
      },
    }.toString;
    disguise(toString, fnToString);
    Function.prototype.toString = toString;

    // --- Date -------------------------------------------------------------
    function FakeDate(...args) {
      if (!new.target) return NativeDate.prototype.toString.call(new NativeDate(now()));
      return Reflect.construct(NativeDate, args.length ? args : [now()], new.target);
    }
    Object.defineProperties(FakeDate, {
      name: { value: 'Date' },
      length: { value: NativeDate.length },
      prototype: { value: NativeDate.prototype, writable: false, enumerable: false, configurable: false },
    });
    const statics = {
      now() {
        return Math.floor(now());
      },
    };
    FakeDate.now = disguise(statics.now, nativeNow);
    FakeDate.parse = NativeDate.parse;
    FakeDate.UTC = NativeDate.UTC;
    Object.defineProperty(NativeDate.prototype, 'constructor', {
      value: FakeDate,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    disguise(FakeDate, NativeDate);
    window.Date = FakeDate;

    // --- Intl.DateTimeFormat: format()/formatToParts() with no argument ------
    const DTF = Intl.DateTimeFormat.prototype;
    const formatDesc = Object.getOwnPropertyDescriptor(DTF, 'format');
    if (formatDesc && formatDesc.get) {
      const origGet = formatDesc.get;
      const cache = new WeakMap();
      const getter = Object.getOwnPropertyDescriptor(
        {
          get format() {
            if (!cache.has(this)) {
              const f = origGet.call(this);
              cache.set(this, (date) => f(date === undefined ? now() : date));
            }
            return cache.get(this);
          },
        },
        'format',
      ).get;
      Object.defineProperty(DTF, 'format', {
        configurable: true,
        enumerable: false,
        get: disguise(getter, origGet),
      });
    }
    const origFormatToParts = DTF.formatToParts;
    if (origFormatToParts) {
      DTF.formatToParts = disguise(
        {
          formatToParts(date) {
            return origFormatToParts.call(this, date === undefined ? now() : date);
          },
        }.formatToParts,
        origFormatToParts,
      );
    }

    // --- Temporal.Now (if the browser ships it) ----------------------------
    const T = globalThis.Temporal;
    if (T && T.Now && T.Instant) {
      const tzId = T.Now.timeZoneId ? T.Now.timeZoneId.bind(T.Now) : () => 'UTC';
      const instant = () => T.Instant.fromEpochMilliseconds(Math.floor(now()));
      const zoned = (tz) => instant().toZonedDateTimeISO(tz === undefined ? tzId() : tz);
      const patch = {
        instant,
        zonedDateTimeISO: zoned,
        plainDateTimeISO: (tz) => zoned(tz).toPlainDateTime(),
        plainDateISO: (tz) => zoned(tz).toPlainDate(),
        plainTimeISO: (tz) => zoned(tz).toPlainTime(),
      };
      for (const [name, fn] of Object.entries(patch)) {
        if (typeof T.Now[name] === 'function') {
          try {
            Object.defineProperty(T.Now, name, {
              value: disguise(fn, T.Now[name]),
              writable: true,
              configurable: true,
            });
          } catch {}
        }
      }
    }
  }

  let initial = null;
  try {
    initial = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {}
  apply(initial);

  // Live updates from bridge.js / popup (detail is a JSON string or null).
  window.addEventListener(EVT, (e) => {
    let cfg = null;
    try {
      cfg = JSON.parse(e.detail || 'null');
    } catch {}
    apply(cfg);
  });
})();
